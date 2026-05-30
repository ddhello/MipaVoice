use std::{
    collections::HashMap,
    future::Future,
    net::SocketAddr,
    pin::Pin,
    str::FromStr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
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
use ice::network_type::NetworkType;
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use password_hash::rand_core::OsRng;
use serde::{Deserialize, Serialize};
use sqlx::{sqlite::SqliteConnectOptions, sqlite::SqlitePoolOptions, FromRow, SqlitePool};
use thiserror::Error;
use tokio::sync::{broadcast, mpsc, Mutex};
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use uuid::Uuid;
use webrtc::{
    api::{media_engine::MediaEngine, setting_engine::SettingEngine, APIBuilder},
    ice_transport::{
        ice_candidate::{RTCIceCandidate, RTCIceCandidateInit},
        ice_candidate_type::RTCIceCandidateType,
    },
    peer_connection::{
        configuration::RTCConfiguration, peer_connection_state::RTCPeerConnectionState,
        sdp::session_description::RTCSessionDescription, RTCPeerConnection,
    },
    rtp_transceiver::rtp_codec::{RTCRtpCodecCapability, RTPCodecType},
    track::{
        track_local::{track_local_static_rtp::TrackLocalStaticRTP, TrackLocal, TrackLocalWriter},
        track_remote::TrackRemote,
    },
};

#[derive(Clone)]
struct AppState {
    db: SqlitePool,
    sfu: SfuConfig,
    sfu_udp_mux: Arc<dyn ice::udp_mux::UDPMux + Send + Sync>,
    sfu_rooms: Arc<SfuRooms>,
    presence: Arc<Mutex<Presence>>,
    events: broadcast::Sender<ServerEvent>,
}

#[derive(Clone)]
struct SfuConfig {
    url: String,
    secret: String,
    public_ip: Option<String>,
    udp_port: u16,
    ice_servers: Vec<IceServerDto>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct IceServerDto {
    urls: Vec<String>,
    username: Option<String>,
    credential: Option<String>,
    credential_type: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
struct SfuClaims {
    sub: String,
    name: String,
    room: String,
    exp: usize,
}

#[derive(Default)]
struct SfuRooms {
    rooms: Mutex<HashMap<String, HashMap<String, Arc<SfuPeer>>>>,
}

struct SfuPeer {
    id: String,
    identity: String,
    room: String,
    pc: Arc<RTCPeerConnection>,
    outbound: mpsc::UnboundedSender<SfuOutboundSignal>,
    published_track: Mutex<Option<Arc<TrackLocalStaticRTP>>>,
    advertised_ip: Option<String>,
    closed: AtomicBool,
}

#[derive(Deserialize)]
struct SfuQuery {
    token: String,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum SfuInboundSignal {
    #[serde(rename = "offer")]
    Offer { sdp: String },
    #[serde(rename = "answer")]
    Answer { sdp: String },
    #[serde(rename = "candidate")]
    Candidate { candidate: RTCIceCandidateInit },
    #[serde(rename = "disconnect")]
    Disconnect,
    #[serde(rename = "ping")]
    Ping,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type")]
enum SfuOutboundSignal {
    #[serde(rename = "answer")]
    Answer { sdp: String },
    #[serde(rename = "offer")]
    Offer { sdp: String },
    #[serde(rename = "candidate")]
    Candidate { candidate: RTCIceCandidateInit },
    #[serde(rename = "participant-left")]
    ParticipantLeft { identity: String },
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
    sfu_url: String,
    ice_servers: Vec<IceServerDto>,
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

    let sfu = SfuConfig {
        url: std::env::var("MIPAVOICE_SFU_URL").unwrap_or_else(|_| "/sfu".into()),
        secret: std::env::var("MIPAVOICE_SFU_SECRET")
            .unwrap_or_else(|_| "dev-secret-change-me".into()),
        public_ip: std::env::var("MIPAVOICE_SFU_PUBLIC_IP")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        udp_port: std::env::var("MIPAVOICE_SFU_UDP_PORT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(50000),
        ice_servers: parse_ice_servers(),
    };
    let sfu_udp_socket = tokio::net::UdpSocket::bind(("0.0.0.0", sfu.udp_port)).await?;
    let sfu_udp_mux =
        ice::udp_mux::UDPMuxDefault::new(ice::udp_mux::UDPMuxParams::new(sfu_udp_socket));
    tracing::info!(
        public_ip = ?sfu.public_ip,
        udp_port = sfu.udp_port,
        "SFU ICE configured with ice_lite=false network=udp4"
    );

    let (events, _) = broadcast::channel(64);

    Ok(AppState {
        db,
        sfu,
        sfu_udp_mux,
        sfu_rooms: Arc::new(SfuRooms::default()),
        presence: Arc::new(Mutex::new(Presence::default())),
        events,
    })
}

fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/ws", get(ws_handler))
        .route("/sfu", get(sfu_handler))
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

fn log_sfu_sdp_candidates(label: &str, identity: &str, room: &str, sdp: &str) {
    for line in sdp.lines() {
        if line == "a=ice-lite" || line.starts_with("a=candidate:") {
            tracing::info!(
                identity = %identity,
                room = %room,
                candidate = %line,
                "{label}"
            );
        }
    }
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
    let token = sfu_token(&state.sfu, &channel, username)?;

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
        sfu_url: state.sfu.url.clone(),
        ice_servers: state.sfu.ice_servers.clone(),
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

async fn sfu_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(query): Query<SfuQuery>,
) -> impl IntoResponse {
    match validate_sfu_token(&state.sfu, &query.token) {
        Ok(claims) => ws.on_upgrade(move |socket| sfu_socket(socket, state, claims)),
        Err(err) => err.into_response(),
    }
}

async fn sfu_socket(mut socket: WebSocket, state: AppState, claims: SfuClaims) {
    let (outbound, mut outbound_rx) = mpsc::unbounded_channel();
    let peer = match create_sfu_peer(&state.sfu, state.sfu_udp_mux.clone(), &claims, outbound).await
    {
        Ok(peer) => peer,
        Err(err) => {
            tracing::warn!("failed to create SFU peer: {err}");
            return;
        }
    };

    if let Err(err) = state.sfu_rooms.join(peer.clone()).await {
        tracing::warn!("failed to join SFU room: {err}");
        let _ = peer.pc.close().await;
        return;
    }

    let rooms = state.sfu_rooms.clone();
    let peer_for_state = peer.clone();
    peer.pc
        .on_peer_connection_state_change(Box::new(move |connection_state| {
            let rooms = rooms.clone();
            let peer = peer_for_state.clone();
            Box::pin(async move {
                tracing::info!(
                    identity = %peer.identity,
                    room = %peer.room,
                    state = ?connection_state,
                    "SFU peer connection state changed"
                );
                if matches!(
                    connection_state,
                    RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed
                ) {
                    cleanup_sfu_peer(rooms, peer).await;
                }
            })
        }));

    loop {
        tokio::select! {
            outbound = outbound_rx.recv() => {
                let Some(outbound) = outbound else {
                    break;
                };
                match serde_json::to_string(&outbound) {
                    Ok(text) => {
                        if socket.send(Message::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(err) => tracing::warn!("failed to encode SFU signal: {err}"),
                }
            }
            inbound = socket.recv() => {
                match inbound {
                    Some(Ok(Message::Text(text))) => {
                        if let Err(err) = handle_sfu_signal(&state.sfu_rooms, &peer, &text).await {
                            tracing::warn!("failed to handle SFU signal: {err}");
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(err)) => {
                        tracing::warn!("SFU websocket error: {err}");
                        break;
                    }
                    _ => {}
                }
            }
        }
    }

    tracing::info!(
        identity = %peer.identity,
        room = %peer.room,
        "SFU signaling socket closed"
    );
}

async fn create_sfu_peer(
    sfu: &SfuConfig,
    udp_mux: Arc<dyn ice::udp_mux::UDPMux + Send + Sync>,
    claims: &SfuClaims,
    outbound: mpsc::UnboundedSender<SfuOutboundSignal>,
) -> anyhow::Result<Arc<SfuPeer>> {
    let mut media_engine = MediaEngine::default();
    media_engine.register_default_codecs()?;
    let mut setting_engine = SettingEngine::default();
    setting_engine.set_network_types(vec![NetworkType::Udp4]);
    setting_engine.set_udp_network(ice::udp_network::UDPNetwork::Muxed(udp_mux));
    if let Some(public_ip) = &sfu.public_ip {
        setting_engine.set_nat_1to1_ips(vec![public_ip.clone()], RTCIceCandidateType::Host);
    }
    let api = APIBuilder::new()
        .with_media_engine(media_engine)
        .with_setting_engine(setting_engine)
        .build();
    let pc = Arc::new(api.new_peer_connection(RTCConfiguration::default()).await?);

    let candidate_outbound = outbound.clone();
    pc.on_ice_candidate(Box::new(move |candidate: Option<RTCIceCandidate>| {
        let candidate_outbound = candidate_outbound.clone();
        Box::pin(async move {
            let Some(candidate) = candidate else {
                return;
            };
            match candidate.to_json() {
                Ok(candidate) => {
                    tracing::info!(
                        candidate = %candidate.candidate,
                        "SFU sending trickle candidate"
                    );
                    let _ = candidate_outbound.send(SfuOutboundSignal::Candidate { candidate });
                }
                Err(err) => tracing::warn!("failed to encode ICE candidate: {err}"),
            }
        })
    }));

    Ok(Arc::new(SfuPeer {
        id: Uuid::new_v4().to_string(),
        identity: claims.name.clone(),
        room: claims.room.clone(),
        pc,
        outbound,
        published_track: Mutex::new(None),
        advertised_ip: sfu.public_ip.clone(),
        closed: AtomicBool::new(false),
    }))
}

fn should_accept_sfu_candidate(
    candidate: &RTCIceCandidateInit,
    _advertised_ip: Option<&str>,
) -> bool {
    let parts = candidate.candidate.split_whitespace().collect::<Vec<_>>();
    if parts.len() < 8 {
        return false;
    }

    if !parts[2].eq_ignore_ascii_case("udp") {
        return false;
    }

    let Some(candidate_type) = parts
        .windows(2)
        .find_map(|pair| pair[0].eq_ignore_ascii_case("typ").then_some(pair[1]))
    else {
        return false;
    };

    match candidate_type.to_ascii_lowercase().as_str() {
        "host" | "relay" | "srflx" | "prflx" => true,
        _ => false,
    }
}

async fn cleanup_sfu_peer(rooms: Arc<SfuRooms>, peer: Arc<SfuPeer>) {
    if peer.closed.swap(true, Ordering::SeqCst) {
        return;
    }

    tracing::info!(
        identity = %peer.identity,
        room = %peer.room,
        "SFU peer cleanup"
    );
    rooms.leave(&peer).await;
    let _ = peer.pc.close().await;
}

async fn handle_sfu_signal(
    rooms: &Arc<SfuRooms>,
    peer: &Arc<SfuPeer>,
    text: &str,
) -> anyhow::Result<()> {
    match serde_json::from_str::<SfuInboundSignal>(text)? {
        SfuInboundSignal::Offer { sdp } => {
            let rooms = rooms.clone();
            let peer_for_track = peer.clone();
            peer.pc.on_track(Box::new(move |track, _, _| {
                let rooms = rooms.clone();
                let peer = peer_for_track.clone();
                Box::pin(async move {
                    rooms.publish_track(peer, track).await;
                }) as Pin<Box<dyn Future<Output = ()> + Send>>
            }));

            let offer = RTCSessionDescription::offer(sdp)?;
            peer.pc.set_remote_description(offer).await?;
            let answer = peer.pc.create_answer(None).await?;
            let mut gather_complete = peer.pc.gathering_complete_promise().await;
            peer.pc.set_local_description(answer).await?;
            let _ = gather_complete.recv().await;
            if let Some(answer) = peer.pc.local_description().await {
                log_sfu_sdp_candidates(
                    "SFU answer SDP candidate",
                    &peer.identity,
                    &peer.room,
                    &answer.sdp,
                );
                let _ = peer
                    .outbound
                    .send(SfuOutboundSignal::Answer { sdp: answer.sdp });
            }
        }
        SfuInboundSignal::Answer { sdp } => {
            let answer = RTCSessionDescription::answer(sdp)?;
            peer.pc.set_remote_description(answer).await?;
        }
        SfuInboundSignal::Candidate { candidate } => {
            if !should_accept_sfu_candidate(&candidate, peer.advertised_ip.as_deref()) {
                tracing::info!(
                    identity = %peer.identity,
                    room = %peer.room,
                    candidate = %candidate.candidate,
                    "SFU ignored client candidate"
                );
                return Ok(());
            }

            tracing::info!(
                identity = %peer.identity,
                room = %peer.room,
                candidate = %candidate.candidate,
                "SFU received client candidate"
            );
            peer.pc.add_ice_candidate(candidate).await?;
        }
        SfuInboundSignal::Disconnect => {
            tracing::info!(
                identity = %peer.identity,
                room = %peer.room,
                "SFU client requested disconnect"
            );
            cleanup_sfu_peer(rooms.clone(), peer.clone()).await;
        }
        SfuInboundSignal::Ping => {}
    }

    Ok(())
}

impl SfuRooms {
    async fn join(&self, peer: Arc<SfuPeer>) -> anyhow::Result<()> {
        let existing_tracks = {
            let mut rooms = self.rooms.lock().await;
            let room = rooms.entry(peer.room.clone()).or_default();
            let tracks = room
                .values()
                .filter(|existing| existing.id != peer.id)
                .filter_map(|existing| existing.published_track.try_lock().ok()?.clone())
                .collect::<Vec<_>>();
            room.insert(peer.id.clone(), peer.clone());
            tracks
        };

        for track in existing_tracks {
            peer.pc
                .add_track(track as Arc<dyn TrackLocal + Send + Sync>)
                .await?;
        }

        Ok(())
    }

    async fn leave(&self, peer: &Arc<SfuPeer>) {
        let peers = {
            let mut rooms = self.rooms.lock().await;
            let Some(room) = rooms.get_mut(&peer.room) else {
                return;
            };
            room.remove(&peer.id);
            let peers = room.values().cloned().collect::<Vec<_>>();
            if room.is_empty() {
                rooms.remove(&peer.room);
            }
            peers
        };

        for target in peers {
            let _ = target.outbound.send(SfuOutboundSignal::ParticipantLeft {
                identity: peer.id.clone(),
            });
        }
    }

    async fn publish_track(&self, peer: Arc<SfuPeer>, track: Arc<TrackRemote>) {
        if track.kind() != RTPCodecType::Audio {
            return;
        }

        let local_track = Arc::new(TrackLocalStaticRTP::new(
            RTCRtpCodecCapability {
                mime_type: track.codec().capability.mime_type,
                clock_rate: track.codec().capability.clock_rate,
                channels: track.codec().capability.channels,
                sdp_fmtp_line: track.codec().capability.sdp_fmtp_line,
                rtcp_feedback: track.codec().capability.rtcp_feedback,
            },
            peer.id.clone(),
            peer.identity.clone(),
        ));

        {
            let mut published = peer.published_track.lock().await;
            *published = Some(local_track.clone());
        }

        let targets = {
            let rooms = self.rooms.lock().await;
            rooms
                .get(&peer.room)
                .map(|room| {
                    room.values()
                        .filter(|target| target.id != peer.id)
                        .cloned()
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        };

        for target in targets {
            if target
                .pc
                .add_track(local_track.clone() as Arc<dyn TrackLocal + Send + Sync>)
                .await
                .is_ok()
            {
                renegotiate_peer(target).await;
            }
        }

        tokio::spawn(async move {
            while let Ok((packet, _)) = track.read_rtp().await {
                if let Err(err) = local_track.write_rtp(&packet).await {
                    tracing::debug!("failed to forward RTP: {err}");
                }
            }
        });
    }
}

async fn renegotiate_peer(peer: Arc<SfuPeer>) {
    match peer.pc.create_offer(None).await {
        Ok(offer) => {
            let mut gather_complete = peer.pc.gathering_complete_promise().await;
            if let Err(err) = peer.pc.set_local_description(offer).await {
                tracing::warn!("failed to set renegotiation offer: {err}");
                return;
            }
            let _ = gather_complete.recv().await;
            if let Some(offer) = peer.pc.local_description().await {
                let _ = peer
                    .outbound
                    .send(SfuOutboundSignal::Offer { sdp: offer.sdp });
            }
        }
        Err(err) => tracing::warn!("failed to create renegotiation offer: {err}"),
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

fn sfu_token(sfu: &SfuConfig, channel: &ChannelRow, username: &str) -> Result<String, ApiError> {
    let claims = SfuClaims {
        sub: username.to_string(),
        name: username.to_string(),
        room: channel.id.clone(),
        exp: (Utc::now() + chrono::Duration::minutes(15)).timestamp() as usize,
    };

    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(sfu.secret.as_bytes()),
    )
    .map_err(|err| ApiError::Token(err.to_string()))
}

fn validate_sfu_token(sfu: &SfuConfig, token: &str) -> Result<SfuClaims, ApiError> {
    decode::<SfuClaims>(
        token,
        &DecodingKey::from_secret(sfu.secret.as_bytes()),
        &Validation::default(),
    )
    .map(|data| data.claims)
    .map_err(|_| ApiError::Forbidden)
}

fn parse_ice_servers() -> Vec<IceServerDto> {
    let raw_urls = std::env::var("MIPAVOICE_ICE_SERVERS")
        .unwrap_or_else(|_| "stun:stun.l.google.com:19302".into());
    let raw_urls = raw_urls.trim();
    if matches!(
        raw_urls.to_ascii_lowercase().as_str(),
        "none" | "off" | "disabled"
    ) {
        return Vec::new();
    }

    let urls = raw_urls
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();

    if urls.is_empty() {
        return Vec::new();
    }

    let username = std::env::var("MIPAVOICE_ICE_USERNAME")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let credential = std::env::var("MIPAVOICE_ICE_CREDENTIAL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    vec![IceServerDto {
        urls,
        username,
        credential,
        credential_type: Some("password".into()),
    }]
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

    #[test]
    fn sfu_candidate_filter_reads_type_after_typ_marker() {
        let srflx = RTCIceCandidateInit {
            candidate: "candidate:1 1 udp 2122260223 203.0.113.10 54321 typ srflx raddr 10.0.0.2 rport 54321".into(),
            ..Default::default()
        };
        let mdns_host = RTCIceCandidateInit {
            candidate: "candidate:2 1 udp 2122260223 7f3a9b7e-8c88-4c4d.local 54321 typ host".into(),
            ..Default::default()
        };
        let tcp_host = RTCIceCandidateInit {
            candidate: "candidate:3 1 tcp 1518280447 192.168.1.42 9 typ host tcptype active".into(),
            ..Default::default()
        };

        assert!(should_accept_sfu_candidate(&srflx, Some("198.51.100.8")));
        assert!(should_accept_sfu_candidate(&mdns_host, Some("198.51.100.8")));
        assert!(!should_accept_sfu_candidate(&tcp_host, None));
    }
}
