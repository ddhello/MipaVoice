export type Channel = {
  id: string;
  name: string;
  creator_name?: string | null;
  has_password: boolean;
  member_count: number;
  created_at: string;
};

export type CreatedChannel = Channel & {
  owner_token: string;
};

export type Participant = {
  session_id: string;
  channel_id: string;
  username: string;
  joined_at: string;
};

export type ChatMessage = {
  id: string;
  channel_id: string;
  username: string;
  body: string;
  created_at: string;
};

export type JoinResponse = {
  channel_id: string;
  session_id: string;
  username: string;
  livekit_url: string;
  token: string;
};

export type SnapshotEvent = {
  type: 'Snapshot';
  payload: {
    channels: Channel[];
    members: Record<string, Participant[]>;
  };
} | {
  type: 'Message';
  payload: {
    message: ChatMessage;
  };
} | {
  type: 'Kicked';
  payload: {
    session_id: string;
    channel_id: string;
  };
};

export const DEFAULT_API_URL = import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:3901';

let currentApiUrl = DEFAULT_API_URL;

export function normalizeServerUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return DEFAULT_API_URL;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

export function setApiBaseUrl(value: string) {
  currentApiUrl = normalizeServerUrl(value);
}

export function getApiBaseUrl() {
  return currentApiUrl;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${currentApiUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(payload.error ?? 'Request failed');
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export const api = {
  listChannels: () => request<Channel[]>('/api/channels'),
  createChannel: (name: string, password: string | undefined, creatorName: string) =>
    request<CreatedChannel>('/api/channels', {
      method: 'POST',
      body: JSON.stringify({ name, password: password || null, creator_name: creatorName }),
    }),
  deleteChannel: (channelId: string, ownerToken: string) =>
    request<void>(`/api/channels/${channelId}`, {
      method: 'DELETE',
      body: JSON.stringify({ owner_token: ownerToken }),
    }),
  kickParticipant: (channelId: string, ownerToken: string, sessionId: string) =>
    request<void>(`/api/channels/${channelId}/kick`, {
      method: 'POST',
      body: JSON.stringify({ owner_token: ownerToken, session_id: sessionId }),
    }),
  listMessages: (channelId: string) => request<ChatMessage[]>(`/api/channels/${channelId}/messages`),
  sendMessage: (channelId: string, sessionId: string, body: string) =>
    request<ChatMessage>(`/api/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ session_id: sessionId, body }),
    }),
  health: async () => {
    const response = await fetch(`${currentApiUrl}/health`, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(response.statusText);
    }
    return response.text();
  },
  joinChannel: (channelId: string, username: string, password?: string) =>
    request<JoinResponse>(`/api/channels/${channelId}/join`, {
      method: 'POST',
      body: JSON.stringify({ username, password: password || null }),
    }),
  leaveChannel: (channelId: string, sessionId: string) =>
    request<void>(`/api/channels/${channelId}/leave`, {
      method: 'POST',
      body: JSON.stringify({ session_id: sessionId }),
    }),
  sendLeaveBeacon: (channelId: string, sessionId: string) => {
    const body = JSON.stringify({ session_id: sessionId });
    const blob = new Blob([body], { type: 'application/json' });
    return navigator.sendBeacon(`${currentApiUrl}/api/channels/${channelId}/leave`, blob);
  },
  heartbeat: (sessionId: string) =>
    request<void>('/api/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ session_id: sessionId }),
    }),
  wsUrl: (sessionId?: string) =>
    `${currentApiUrl.replace(/^http/i, 'ws')}/ws${sessionId ? `?session_id=${sessionId}` : ''}`,
};
