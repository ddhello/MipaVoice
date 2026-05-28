use std::{
    collections::HashMap,
    net::SocketAddr,
    str::FromStr,
    sync::Arc,
    time::{Duration, Instant},
};

use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use livekit_api::access_token::{AccessToken, VideoGrants};
use password_hash::rand_core::OsRng;
use serde::{Deserialize, Serialize};
use sqlx::{sqlite::SqliteConnectOptions, sqlite::SqlitePoolOptions, FromRow, SqlitePool};
use thiserror::Error;
use tokio::sync::{broadcast, Mutex};
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use uuid::Uuid;

#[derive(Clone)]
struct AppState {
    db: SqlitePool,
    livekit: LiveKitConfig,
    presence: Arc<Mutex<Presence>>,
    events: broadcast::Sender<ServerEvent>,
}

#[derive(Clone)]
struct LiveKitConfig {
    url: String,
    api_key: String,
    api_secret: String,
}

#[derive(Default)]
struct Presence {
    sessions: HashMap<Uuid, Participant>,
}

#[derive(Clone, Serialize)]
struct Participant {
    session_id: Uuid,
    channel_id: Uuid,
    username: String,
    joined_at: DateTime<Utc>,
    #[serde(skip)]
    last_seen: Instant,
}

#[derive(Debug, FromRow)]
struct ChannelRow {
    id: String,
    name: String,
    password_hash: Option<String>,
    creator_name: Option<String>,
    delete_token_hash: Option<String>,
    created_at: DateTime<Utc>,
}

#[derive(Clone, Serialize, FromRow)]
struct ChatMessage {
    id: String,
    channel_id: String,
    username: String,
    body: String,
    created_at: DateTime<Utc>,
}

#[derive(Clone, Serialize)]
struct ChannelDto {
    id: Uuid,
    name: String,
    creator_name: Option<String>,
    has_password: bool,
    member_count: usize,
    created_at: DateTime<Utc>,
}

#[derive(Serialize)]
struct CreateChannelResponse {
    #[serde(flatten)]
    channel: ChannelDto,
    owner_token: String,
}

#[derive(Deserialize)]
struct CreateChannelRequest {
    name: String,
    password: Option<String>,
    creator_name: Option<String>,
}

#[derive(Deserialize)]
struct JoinChannelRequest {
    username: String,
    password: Option<String>,
}

#[derive(Serialize)]
struct JoinChannelResponse {
    channel_id: Uuid,
    session_id: Uuid,
    username: String,
    livekit_url: String,
    token: String,
}

#[derive(Deserialize)]
struct LeaveChannelRequest {
    session_id: Uuid,
}

#[derive(Deserialize)]
struct HeartbeatRequest {
    session_id: Uuid,
}

#[derive(Deserialize)]
struct DeleteChannelRequest {
    owner_token: String,
}

#[derive(Deserialize)]
struct KickParticipantRequest {
    owner_token: String,
    session_id: Uuid,
}

#[derive(Deserialize)]
struct SendMessageRequest {
    session_id: Uuid,
    body: String,
}

#[derive(Deserialize)]
struct WsQuery {
    session_id: Option<Uuid>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", content = "payload")]
enum ServerEvent {
    Snapshot {
        channels: Vec<ChannelDto>,
        members: HashMap<Uuid, Vec<Participant>>,
    },
    Message {
        message: ChatMessage,
    },
    Kicked {
        session_id: Uuid,
        channel_id: Uuid,
    },
}

#[derive(Error, Debug)]
enum ApiError {
    #[error("not found")]
    NotFound,
    #[error("channel name is required")]
    EmptyChannelName,
    #[error("username is required")]
    EmptyUsername,
    #[error("invalid password")]
    InvalidPassword,
    #[error("channel password is required")]
    PasswordRequired,
    #[error("not allowed")]
    Forbidden,
    #[error("database error")]
    Db(#[from] sqlx::Error),
    #[error("token error")]
    Token(String),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = match self {
            ApiError::NotFound => StatusCode::NOT_FOUND,
            ApiError::EmptyChannelName | ApiError::EmptyUsername | ApiError::PasswordRequired => {
                StatusCode::BAD_REQUEST
            }
            ApiError::InvalidPassword => StatusCode::UNAUTHORIZED,
            ApiError::Forbidden => StatusCode::FORBIDDEN,
            ApiError::Db(_) | ApiError::Token(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };

        let body = serde_json::json!({
            "error": self.to_string(),
        });

        (status, Json(body)).into_response()
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let state = build_state().await?;
    let app = build_router(state);
    let addr: SocketAddr = std::env::var("MIPAVOICE_BIND_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:3901".to_string())
        .parse()?;

    tracing::info!("MipaVoice server listening on http://{addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

async fn build_state() -> anyhow::Result<AppState> {
    let database_url =
        std::env::var("MIPAVOICE_DATABASE_URL").unwrap_or_else(|_| "sqlite://mipavoice.db".into());
    let options = SqliteConnectOptions::from_str(&database_url)?.create_if_missing(true);
    let db = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await?;
    migrate(&db).await?;

    let livekit = LiveKitConfig {
        url: std::env::var("LIVEKIT_URL").unwrap_or_else(|_| "ws://127.0.0.1:7880".into()),
        api_key: std::env::var("LIVEKIT_API_KEY").unwrap_or_else(|_| "devkey".into()),
        api_secret: std::env::var("LIVEKIT_API_SECRET").unwrap_or_else(|_| "secret".into()),
    };

    let (events, _) = broadcast::channel(64);

    Ok(AppState {
        db,
        livekit,
        presence: Arc::new(Mutex::new(Presence::default())),
        events,
    })
}

fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/ws", get(ws_handler))
        .route("/api/channels", get(list_channels).post(create_channel))
        .route("/api/channels/{channel_id}", delete(delete_channel))
        .route("/api/channels/{channel_id}/join", post(join_channel))
        .route("/api/channels/{channel_id}/leave", post(leave_channel))
        .route("/api/channels/{channel_id}/members", get(list_members))
        .route("/api/channels/{channel_id}/kick", post(kick_participant))
        .route(
            "/api/channels/{channel_id}/messages",
            get(list_messages).post(send_message),
        )
        .route("/api/heartbeat", post(heartbeat))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn migrate(db: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS channels (
            id TEXT PRIMARY KEY NOT NULL,
            name TEXT NOT NULL UNIQUE,
            password_hash TEXT,
            creator_name TEXT,
            delete_token_hash TEXT,
            created_at TEXT NOT NULL
        );
        "#,
    )
    .execute(db)
    .await?;

    let _ = sqlx::query("ALTER TABLE channels ADD COLUMN creator_name TEXT")
        .execute(db)
        .await;
    let _ = sqlx::query("ALTER TABLE channels ADD COLUMN delete_token_hash TEXT")
        .execute(db)
        .await;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY NOT NULL,
            channel_id TEXT NOT NULL,
            username TEXT NOT NULL,
            body TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
        );
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages(channel_id, created_at)",
    )
    .execute(db)
    .await?;

    Ok(())
}

async fn list_channels(State(state): State<AppState>) -> Result<Json<Vec<ChannelDto>>, ApiError> {
    Ok(Json(channel_dtos(&state).await?))
}

async fn create_channel(
    State(state): State<AppState>,
    Json(payload): Json<CreateChannelRequest>,
) -> Result<Json<CreateChannelResponse>, ApiError> {
    let name = payload.name.trim();
    if name.is_empty() {
        return Err(ApiError::EmptyChannelName);
    }

    let id = Uuid::new_v4();
    let now = Utc::now();
    let owner_token = Uuid::new_v4().to_string();
    let owner_token_hash = hash_password(&owner_token)?;
    let creator_name = payload
        .creator_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let password_hash = match payload.password.as_deref().map(str::trim) {
        Some("") | None => None,
        Some(password) => Some(hash_password(password)?),
    };

    sqlx::query(
        "INSERT INTO channels (id, name, password_hash, creator_name, delete_token_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
        .bind(id.to_string())
        .bind(name)
        .bind(password_hash)
        .bind(&creator_name)
        .bind(owner_token_hash)
        .bind(now)
        .execute(&state.db)
        .await?;

    publish_snapshot(&state).await;

    Ok(Json(CreateChannelResponse {
        channel: ChannelDto {
            id,
            name: name.to_string(),
            creator_name,
            has_password: payload
                .password
                .as_deref()
                .map(|p| !p.trim().is_empty())
                .unwrap_or(false),
            member_count: 0,
            created_at: now,
        },
        owner_token,
    }))
}

async fn delete_channel(
    State(state): State<AppState>,
    Path(channel_id): Path<Uuid>,
    Json(payload): Json<DeleteChannelRequest>,
) -> Result<StatusCode, ApiError> {
    ensure_owner(&state.db, channel_id, &payload.owner_token).await?;

    sqlx::query("DELETE FROM channels WHERE id = ?1")
        .bind(channel_id.to_string())
        .execute(&state.db)
        .await?;

    {
        let mut presence = state.presence.lock().await;
        presence
            .sessions
            .retain(|_, participant| participant.channel_id != channel_id);
    }

    publish_snapshot(&state).await;
    Ok(StatusCode::NO_CONTENT)
}

async fn kick_participant(
    State(state): State<AppState>,
    Path(channel_id): Path<Uuid>,
    Json(payload): Json<KickParticipantRequest>,
) -> Result<StatusCode, ApiError> {
    ensure_owner(&state.db, channel_id, &payload.owner_token).await?;

    let kicked = {
        let mut presence = state.presence.lock().await;
        match presence.sessions.get(&payload.session_id) {
            Some(participant) if participant.channel_id == channel_id => {
                presence.sessions.remove(&payload.session_id);
                true
            }
            _ => false,
        }
    };

    if kicked {
        let _ = state.events.send(ServerEvent::Kicked {
            session_id: payload.session_id,
            channel_id,
        });
        publish_snapshot(&state).await;
    }

    Ok(StatusCode::NO_CONTENT)
}

async fn list_messages(
    State(state): State<AppState>,
    Path(channel_id): Path<Uuid>,
) -> Result<Json<Vec<ChatMessage>>, ApiError> {
    get_channel(&state.db, channel_id).await?;
    let messages = sqlx::query_as::<_, ChatMessage>(
        "SELECT id, channel_id, username, body, created_at FROM messages WHERE channel_id = ?1 ORDER BY created_at ASC",
    )
    .bind(channel_id.to_string())
    .fetch_all(&state.db)
    .await?;

    Ok(Json(messages))
}

async fn send_message(
    State(state): State<AppState>,
    Path(channel_id): Path<Uuid>,
    Json(payload): Json<SendMessageRequest>,
) -> Result<Json<ChatMessage>, ApiError> {
    let body = payload.body.trim();
    if body.is_empty() {
        return Err(ApiError::EmptyChannelName);
    }

    let participant = {
        let presence = state.presence.lock().await;
        presence
            .sessions
            .get(&payload.session_id)
            .filter(|participant| participant.channel_id == channel_id)
            .cloned()
    }
    .ok_or(ApiError::Forbidden)?;

    let message = ChatMessage {
        id: Uuid::new_v4().to_string(),
        channel_id: channel_id.to_string(),
        username: participant.username,
        body: body.chars().take(2000).collect(),
        created_at: Utc::now(),
    };

    sqlx::query(
        "INSERT INTO messages (id, channel_id, username, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
    .bind(&message.id)
    .bind(&message.channel_id)
    .bind(&message.username)
    .bind(&message.body)
    .bind(message.created_at)
    .execute(&state.db)
    .await?;

    let _ = state.events.send(ServerEvent::Message {
        message: message.clone(),
    });

    Ok(Json(message))
}

async fn join_channel(
    State(state): State<AppState>,
    Path(channel_id): Path<Uuid>,
    Json(payload): Json<JoinChannelRequest>,
) -> Result<Json<JoinChannelResponse>, ApiError> {
    let username = payload.username.trim();
    if username.is_empty() {
        return Err(ApiError::EmptyUsername);
    }

    let channel = get_channel(&state.db, channel_id).await?;
    validate_channel_password(&channel, payload.password.as_deref())?;

    let session_id = Uuid::new_v4();
    let token = livekit_token(&state.livekit, &channel, username)?;

    {
        let mut presence = state.presence.lock().await;
        presence.sessions.insert(
            session_id,
            Participant {
                session_id,
                channel_id,
                username: username.to_string(),
                joined_at: Utc::now(),
                last_seen: Instant::now(),
            },
        );
    }

    publish_snapshot(&state).await;

    Ok(Json(JoinChannelResponse {
        channel_id,
        session_id,
        username: username.to_string(),
        livekit_url: state.livekit.url.clone(),
        token,
    }))
}

async fn leave_channel(
    State(state): State<AppState>,
    Path(_channel_id): Path<Uuid>,
    Json(payload): Json<LeaveChannelRequest>,
) -> Result<StatusCode, ApiError> {
    remove_session(&state, payload.session_id).await;

    Ok(StatusCode::NO_CONTENT)
}

async fn heartbeat(
    State(state): State<AppState>,
    Json(payload): Json<HeartbeatRequest>,
) -> Result<StatusCode, ApiError> {
    let changed = {
        let mut presence = state.presence.lock().await;
        if let Some(participant) = presence.sessions.get_mut(&payload.session_id) {
            participant.last_seen = Instant::now();
        }

        let before = presence.sessions.len();
        presence
            .sessions
            .retain(|_, participant| participant.last_seen.elapsed() < Duration::from_secs(45));
        before != presence.sessions.len()
    };

    if changed {
        publish_snapshot(&state).await;
    }

    Ok(StatusCode::NO_CONTENT)
}

async fn list_members(
    State(state): State<AppState>,
    Path(channel_id): Path<Uuid>,
) -> Result<Json<Vec<Participant>>, ApiError> {
    Ok(Json(members_for_channel(&state, channel_id).await))
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(query): Query<WsQuery>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| websocket(socket, state, query.session_id))
}

async fn websocket(mut socket: WebSocket, state: AppState, session_id: Option<Uuid>) {
    let _ = send_snapshot(&mut socket, &state).await;
    let mut rx = state.events.subscribe();

    loop {
        tokio::select! {
            event = rx.recv() => {
                match event {
                    Ok(event) => {
                        if let Ok(text) = serde_json::to_string(&event) {
                            if socket.send(Message::Text(text.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Text(text))) if text == "ping" => {
                        if let Some(id) = session_id {
                            let _ = heartbeat(State(state.clone()), Json(HeartbeatRequest { session_id: id })).await;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(_)) => break,
                    _ => {}
                }
            }
        }
    }

    if let Some(id) = session_id {
        remove_session(&state, id).await;
    }
}

async fn send_snapshot(socket: &mut WebSocket, state: &AppState) -> Result<(), axum::Error> {
    if let Ok(event) = snapshot_event(state).await {
        if let Ok(text) = serde_json::to_string(&event) {
            socket.send(Message::Text(text.into())).await?;
        }
    }
    Ok(())
}

async fn publish_snapshot(state: &AppState) {
    if let Ok(event) = snapshot_event(state).await {
        let _ = state.events.send(event);
    }
}

async fn remove_session(state: &AppState, session_id: Uuid) {
    let removed = {
        let mut presence = state.presence.lock().await;
        presence.sessions.remove(&session_id).is_some()
    };

    if removed {
        publish_snapshot(state).await;
    }
}

async fn snapshot_event(state: &AppState) -> Result<ServerEvent, ApiError> {
    let channels = channel_dtos(state).await?;
    let mut members = HashMap::new();
    let presence = state.presence.lock().await;
    for participant in presence.sessions.values() {
        members
            .entry(participant.channel_id)
            .or_insert_with(Vec::new)
            .push(participant.clone());
    }

    Ok(ServerEvent::Snapshot { channels, members })
}

async fn channel_dtos(state: &AppState) -> Result<Vec<ChannelDto>, ApiError> {
    let rows = sqlx::query_as::<_, ChannelRow>(
        "SELECT id, name, password_hash, creator_name, delete_token_hash, created_at FROM channels ORDER BY created_at ASC",
    )
    .fetch_all(&state.db)
    .await?;
    let counts = member_counts(state).await;

    rows.into_iter()
        .map(|row| {
            let id = Uuid::parse_str(&row.id).map_err(|_| ApiError::NotFound)?;
            Ok(ChannelDto {
                member_count: counts.get(&id).copied().unwrap_or(0),
                id,
                name: row.name,
                creator_name: row.creator_name,
                has_password: row.password_hash.is_some(),
                created_at: row.created_at,
            })
        })
        .collect()
}

async fn member_counts(state: &AppState) -> HashMap<Uuid, usize> {
    let presence = state.presence.lock().await;
    let mut counts = HashMap::new();
    for participant in presence.sessions.values() {
        *counts.entry(participant.channel_id).or_insert(0) += 1;
    }
    counts
}

async fn members_for_channel(state: &AppState, channel_id: Uuid) -> Vec<Participant> {
    let presence = state.presence.lock().await;
    presence
        .sessions
        .values()
        .filter(|participant| participant.channel_id == channel_id)
        .cloned()
        .collect()
}

async fn get_channel(db: &SqlitePool, channel_id: Uuid) -> Result<ChannelRow, ApiError> {
    sqlx::query_as::<_, ChannelRow>(
        "SELECT id, name, password_hash, creator_name, delete_token_hash, created_at FROM channels WHERE id = ?1",
    )
    .bind(channel_id.to_string())
    .fetch_optional(db)
    .await?
    .ok_or(ApiError::NotFound)
}

async fn ensure_owner(
    db: &SqlitePool,
    channel_id: Uuid,
    owner_token: &str,
) -> Result<ChannelRow, ApiError> {
    let channel = get_channel(db, channel_id).await?;
    let Some(hash) = channel.delete_token_hash.as_deref() else {
        return Err(ApiError::Forbidden);
    };

    let parsed = PasswordHash::new(hash).map_err(|_| ApiError::Forbidden)?;
    Argon2::default()
        .verify_password(owner_token.as_bytes(), &parsed)
        .map_err(|_| ApiError::Forbidden)?;

    Ok(channel)
}

fn hash_password(password: &str) -> Result<String, ApiError> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|err| ApiError::Token(err.to_string()))
}

fn validate_channel_password(channel: &ChannelRow, password: Option<&str>) -> Result<(), ApiError> {
    match (&channel.password_hash, password.map(str::trim)) {
        (None, _) => Ok(()),
        (Some(_), None | Some("")) => Err(ApiError::PasswordRequired),
        (Some(hash), Some(password)) => {
            let parsed = PasswordHash::new(hash).map_err(|_| ApiError::InvalidPassword)?;
            Argon2::default()
                .verify_password(password.as_bytes(), &parsed)
                .map_err(|_| ApiError::InvalidPassword)
        }
    }
}

fn livekit_token(
    livekit: &LiveKitConfig,
    channel: &ChannelRow,
    username: &str,
) -> Result<String, ApiError> {
    let room = channel.id.clone();
    let grants = VideoGrants {
        room_join: true,
        room: room.clone(),
        can_publish: true,
        can_subscribe: true,
        ..Default::default()
    };

    AccessToken::with_api_key(&livekit.api_key, &livekit.api_secret)
        .with_identity(username)
        .with_name(username)
        .with_grants(grants)
        .to_jwt()
        .map_err(|err| ApiError::Token(err.to_string()))
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_hash_verifies_and_rejects_wrong_password() {
        let hash = hash_password("secret").expect("hash");
        let channel = ChannelRow {
            id: Uuid::new_v4().to_string(),
            name: "General".into(),
            password_hash: Some(hash),
            creator_name: None,
            delete_token_hash: None,
            created_at: Utc::now(),
        };

        assert!(validate_channel_password(&channel, Some("secret")).is_ok());
        assert!(matches!(
            validate_channel_password(&channel, Some("wrong")),
            Err(ApiError::InvalidPassword)
        ));
    }

    #[test]
    fn no_password_channel_accepts_empty_password() {
        let channel = ChannelRow {
            id: Uuid::new_v4().to_string(),
            name: "Open".into(),
            password_hash: None,
            creator_name: None,
            delete_token_hash: None,
            created_at: Utc::now(),
        };

        assert!(validate_channel_password(&channel, None).is_ok());
    }
}
