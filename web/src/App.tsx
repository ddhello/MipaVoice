import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Hash,
  Headphones,
  Lock,
  LogOut,
  Mic,
  MicOff,
  PhoneOff,
  Plus,
  Radio,
  RefreshCw,
  Settings,
  Trash2,
  Users,
  Volume2,
  X,
} from 'lucide-react';
import {
  DEFAULT_API_URL,
  api,
  ChatMessage,
  Channel,
  getApiBaseUrl,
  normalizeServerUrl,
  Participant,
  setApiBaseUrl,
  SnapshotEvent,
} from './api';
import { connectVoice, VoiceConnection } from './livekit';

type ActiveVoice = {
  channel: Channel;
  sessionId: string;
};

type AudioDevices = {
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
};

type ServerInfo = {
  flag: string;
  countryCode?: string;
  label: string;
  latency: number | null;
};

const text = {
  idle: '\u7a7a\u95f2',
  entryHint: '\u8f93\u5165\u4e00\u4e2a\u7528\u6237\u540d\uff0c\u52a0\u5165\u8bed\u97f3\u9891\u9053\u3002',
  username: '\u7528\u6237\u540d',
  enter: '\u8fdb\u5165',
  voiceChannels: '\u8bed\u97f3\u9891\u9053',
  refreshChannels: '\u5237\u65b0\u9891\u9053',
  newChannel: '\u65b0\u5efa\u9891\u9053',
  noChannels: '\u8fd8\u6ca1\u6709\u9891\u9053\u3002\u521b\u5efa\u4e00\u4e2a\u5c31\u53ef\u4ee5\u5f00\u59cb\u8bf4\u8bdd\u3002',
  settings: '\u8bbe\u7f6e',
  changeUsername: '\u66f4\u6362\u7528\u6237\u540d',
  currentChannel: '\u5f53\u524d\u9891\u9053',
  notConnected: '\u672a\u8fde\u63a5',
  members: '\u6210\u5458',
  you: '\u4f60',
  noMembers: '\u52a0\u5165\u4e00\u4e2a\u9891\u9053\u540e\uff0c\u8fd9\u91cc\u4f1a\u663e\u793a\u5728\u7ebf\u6210\u5458\u3002',
  noActiveChannel: '\u672a\u52a0\u5165\u9891\u9053',
  chooseChannel: '\u9009\u62e9\u4e00\u4e2a\u9891\u9053\u5f00\u59cb\u8bed\u97f3',
  online: '\u4eba\u5728\u7ebf',
  meterLabel: '\u5f53\u524d\u9ea6\u514b\u98ce\u97f3\u91cf',
  unmute: '\u53d6\u6d88\u9759\u97f3',
  mute: '\u9759\u97f3\u9ea6\u514b\u98ce',
  hangup: '\u6302\u65ad',
  createChannel: '\u521b\u5efa\u9891\u9053',
  channelName: '\u9891\u9053\u540d\u79f0',
  channelPassword: '\u9891\u9053\u5bc6\u7801',
  optional: '\u53ef\u9009',
  create: '\u521b\u5efa',
  join: '\u52a0\u5165',
  server: '\u540e\u7aef\u670d\u52a1\u5668',
  saveServer: '\u4fdd\u5b58\u670d\u52a1\u5668',
  currentConnection: '\u5f53\u524d\u8fde\u63a5',
  defaultServer: '\u9ed8\u8ba4',
  refreshDevices: '\u5237\u65b0\u8bbe\u5907',
  inputDevice: '\u8f93\u5165\u8bbe\u5907',
  outputDevice: '\u8f93\u51fa\u8bbe\u5907',
  defaultMic: '\u7cfb\u7edf\u9ed8\u8ba4\u9ea6\u514b\u98ce',
  defaultSpeaker: '\u7cfb\u7edf\u9ed8\u8ba4\u626c\u58f0\u5668',
  mic: '\u9ea6\u514b\u98ce',
  speaker: '\u626c\u58f0\u5668',
  deviceNote: '\u5982\u679c\u8bbe\u5907\u540d\u79f0\u6ca1\u6709\u663e\u793a\uff0c\u5148\u52a0\u5165\u4e00\u6b21\u9891\u9053\u5e76\u5141\u8bb8\u9ea6\u514b\u98ce\u6743\u9650\u540e\u518d\u5237\u65b0\u3002',
  close: '\u5173\u95ed',
  ok: '\u77e5\u9053\u4e86',
  deleteChannel: '\u5220\u9664\u9891\u9053',
  kick: '\u8e22\u51fa',
  chat: '\u6587\u5b57\u804a\u5929',
  messagePlaceholder: '\u53d1\u9001\u6d88\u606f...',
  send: '\u53d1\u9001',
  kicked: '\u4f60\u5df2\u88ab\u9891\u9053\u521b\u5efa\u8005\u8e22\u51fa',
  localVolume: '\u672c\u5730\u63a5\u6536\u97f3\u91cf',
};

function ownerTokensFromStorage() {
  try {
    return JSON.parse(localStorage.getItem('mipavoice.channelOwnerTokens') ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

function isLocalHost(host: string) {
  const clean = host.toLowerCase();
  return (
    clean === 'localhost' ||
    clean === '127.0.0.1' ||
    clean === '::1' ||
    clean.startsWith('192.168.') ||
    clean.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(clean)
  );
}

function flagFromCountry(code: string) {
  return code
    .toUpperCase()
    .replace(/./g, (char) => String.fromCodePoint(127397 + char.charCodeAt(0)));
}

type GeoLookup = {
  success?: boolean;
  country?: string;
  country_code?: string;
  flag?: {
    emoji?: string;
  };
};

type IpApiLookup = {
  country_code?: string;
  country_name?: string;
  error?: boolean;
};

type DnsLookup = {
  Answer?: Array<{
    data?: string;
    type?: number;
  }>;
};

type ResolvedGeo = {
  flag: string;
  countryCode: string;
  location: string;
};

function isIpv4(value: string) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(value);
}

function normalizeCountryCode(code: string) {
  const clean = code.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(clean) ? clean : '';
}

async function resolveHostIp(host: string) {
  if (isIpv4(host)) return host;

  const response = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A`);
  if (!response.ok) return '';

  const payload = (await response.json()) as DnsLookup;
  return payload.Answer?.find((answer) => answer.type === 1 && answer.data && isIpv4(answer.data))?.data ?? '';
}

async function lookupGeoTarget(target: string): Promise<ResolvedGeo | null> {
  try {
    const response = await fetch(`https://ipwho.is/${encodeURIComponent(target)}`);
    if (response.ok) {
      const payload = (await response.json()) as GeoLookup;
      const countryCode = normalizeCountryCode(payload.country_code ?? '');
      if (payload.success !== false && countryCode) {
        return {
          flag: payload.flag?.emoji || flagFromCountry(countryCode),
          countryCode,
          location: payload.country || countryCode,
        };
      }
    }
  } catch {
    // Try the fallback provider below.
  }

  try {
    const response = await fetch(`https://ipapi.co/${encodeURIComponent(target)}/json/`);
    if (!response.ok) return null;

    const payload = (await response.json()) as IpApiLookup;
    const countryCode = normalizeCountryCode(payload.country_code ?? '');
    if (!payload.error && countryCode) {
      return {
        flag: flagFromCountry(countryCode),
        countryCode,
        location: payload.country_name || countryCode,
      };
    }
  } catch {
    return null;
  }

  return null;
}

async function lookupServerGeo(host: string) {
  const direct = await lookupGeoTarget(host);
  if (direct) return direct;

  const ip = await resolveHostIp(host).catch(() => '');
  if (!ip || ip === host) return null;

  return lookupGeoTarget(ip);
}

function playToneSequence(steps: Array<{ frequency: number; start: number; duration: number }>) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  const context = new AudioContextClass();
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  gain.connect(context.destination);

  for (const step of steps) {
    const oscillator = context.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(step.frequency, context.currentTime + step.start);
    oscillator.connect(gain);
    gain.gain.exponentialRampToValueAtTime(0.08, context.currentTime + step.start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + step.start + step.duration);
    oscillator.start(context.currentTime + step.start);
    oscillator.stop(context.currentTime + step.start + step.duration);
  }

  window.setTimeout(() => context.close().catch(() => undefined), 700);
}

function playJoinSound() {
  playToneSequence([
    { frequency: 660, start: 0, duration: 0.13 },
    { frequency: 880, start: 0.15, duration: 0.16 },
  ]);
}

function playLeaveSound() {
  playToneSequence([{ frequency: 520, start: 0, duration: 0.22 }]);
}

function hostFromServerUrl(value: string) {
  try {
    return new URL(normalizeServerUrl(value)).hostname;
  } catch {
    return '';
  }
}

export function App() {
  const [username, setUsername] = useState(() => localStorage.getItem('mipavoice.username') ?? '');
  const [draftName, setDraftName] = useState(username);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [members, setMembers] = useState<Record<string, Participant[]>>({});
  const [active, setActive] = useState<ActiveVoice | null>(null);
  const [muted, setMuted] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState(text.idle);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createPassword, setCreatePassword] = useState('');
  const [passwordChannel, setPasswordChannel] = useState<Channel | null>(null);
  const [joinPassword, setJoinPassword] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [devices, setDevices] = useState<AudioDevices>({ inputs: [], outputs: [] });
  const [inputDeviceId, setInputDeviceId] = useState(() => localStorage.getItem('mipavoice.inputDeviceId') ?? '');
  const [outputDeviceId, setOutputDeviceId] = useState(() => localStorage.getItem('mipavoice.outputDeviceId') ?? '');
  const [serverUrl, setServerUrl] = useState(() => localStorage.getItem('mipavoice.serverUrl') ?? '');
  const [serverDraft, setServerDraft] = useState(() => localStorage.getItem('mipavoice.serverUrl') ?? '');
  const [audioLevel, setAudioLevel] = useState(0);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatDraft, setChatDraft] = useState('');
  const [ownerTokens, setOwnerTokens] = useState(ownerTokensFromStorage);
  const [serverInfo, setServerInfo] = useState<ServerInfo>({ flag: '\uD83C\uDF10', label: '\u672c\u5730\u6216\u672a\u77e5\u670d\u52a1\u5668', latency: null });
  const [participantVolumes, setParticipantVolumes] = useState<Record<string, number>>({});
  const [activeSpeakers, setActiveSpeakers] = useState<string[]>([]);
  const voiceRef = useRef<VoiceConnection | null>(null);
  const joinLockRef = useRef(false);

  const signedIn = username.trim().length > 0;
  const activeMembers = active ? members[active.channel.id] ?? [] : [];

  useEffect(() => {
    setApiBaseUrl(serverUrl);
  }, [serverUrl]);

  const loadChannels = useCallback(async () => {
    setError(null);
    const next = await api.listChannels();
    setChannels(next);
  }, [serverUrl]);

  const loadDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setError('\u5f53\u524d\u73af\u5883\u4e0d\u652f\u6301\u97f3\u9891\u8bbe\u5907\u679a\u4e3e');
      return;
    }

    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setDevices({
        inputs: list.filter((device) => device.kind === 'audioinput'),
        outputs: list.filter((device) => device.kind === 'audiooutput'),
      });
    } catch {
      setError('\u65e0\u6cd5\u8bfb\u53d6\u97f3\u9891\u8bbe\u5907\u5217\u8868');
    }
  }, []);

  const refreshServerInfo = useCallback(async () => {
    const baseUrl = getApiBaseUrl();
    const host = hostFromServerUrl(baseUrl);
    const started = performance.now();
    let latency: number | null = null;

    try {
      await api.health();
      latency = Math.round(performance.now() - started);
    } catch {
      latency = null;
    }

    if (!host || isLocalHost(host)) {
      setServerInfo({ flag: '\uD83C\uDF10', label: '\u672c\u5730\u670d\u52a1\u5668', latency });
      return;
    }

    try {
      const geo = await lookupServerGeo(host);
      setServerInfo({
        flag: geo?.flag ?? '\uD83C\uDF10',
        countryCode: geo?.countryCode,
        label: geo?.location ? `${host} - ${geo.location}` : host,
        latency,
      });
    } catch {
      setServerInfo({ flag: '\uD83C\uDF10', label: host, latency });
    }
  }, [serverUrl]);

  useEffect(() => {
    loadChannels().catch((err) => setError(err.message));
  }, [loadChannels]);

  useEffect(() => {
    loadDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', loadDevices);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', loadDevices);
  }, [loadDevices]);

  useEffect(() => {
    refreshServerInfo();
    const interval = window.setInterval(refreshServerInfo, 10000);
    return () => window.clearInterval(interval);
  }, [refreshServerInfo]);

  useEffect(() => {
    const ws = new WebSocket(api.wsUrl(active?.sessionId));
    ws.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as SnapshotEvent;
        if (event.type === 'Snapshot') {
          setChannels(event.payload.channels);
          setMembers(event.payload.members);
        } else if (event.type === 'Message') {
          setChatMessages((current) => {
            if (!active || event.payload.message.channel_id !== active.channel.id) return current;
            if (current.some((message) => message.id === event.payload.message.id)) return current;
            return [...current, event.payload.message];
          });
        } else if (event.type === 'Kicked' && active?.sessionId === event.payload.session_id) {
          voiceRef.current?.disconnect();
          voiceRef.current = null;
          setActive(null);
          setVoiceStatus(text.idle);
          setAudioLevel(0);
          playLeaveSound();
          setError(text.kicked);
        }
      } catch {
        setError('\u6536\u5230\u4e86\u4e00\u6761\u65e0\u6cd5\u8bc6\u522b\u7684\u5b9e\u65f6\u6d88\u606f');
      }
    };
    ws.onerror = () => setError('\u5b9e\u65f6\u72b6\u6001\u8fde\u63a5\u5df2\u65ad\u5f00');
    const heartbeat = window.setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send('ping');
      }
    }, 15000);

    return () => {
      window.clearInterval(heartbeat);
      ws.close();
    };
  }, [active?.sessionId, serverUrl]);

  useEffect(() => {
    if (!active) {
      setChatMessages([]);
      return;
    }

    api
      .listMessages(active.channel.id)
      .then(setChatMessages)
      .catch((err) => setError(err.message));
  }, [active?.channel.id]);

  useEffect(() => {
    if (!active?.sessionId) return;
    const heartbeat = window.setInterval(() => {
      api.heartbeat(active.sessionId).catch(() => undefined);
    }, 15000);
    return () => window.clearInterval(heartbeat);
  }, [active?.sessionId]);

  useEffect(() => {
    if (!active) return;

    const leaveOnPageExit = () => {
      api.sendLeaveBeacon(active.channel.id, active.sessionId);
      voiceRef.current?.disconnect();
    };

    window.addEventListener('pagehide', leaveOnPageExit);
    return () => window.removeEventListener('pagehide', leaveOnPageExit);
  }, [active]);

  useEffect(() => {
    voiceRef.current?.setMuted(muted).catch((err) => setError(err.message));
  }, [muted]);

  useEffect(() => {
    let disposed = false;
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let frame = 0;

    const startMeter = async () => {
      if (!active || muted || !navigator.mediaDevices?.getUserMedia) {
        setAudioLevel(0);
        return;
      }

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: inputDeviceId ? { deviceId: { exact: inputDeviceId } } : true,
        });
        if (disposed) return;

        context = new AudioContext();
        const source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        const samples = new Uint8Array(analyser.frequencyBinCount);

        const tick = () => {
          analyser.getByteTimeDomainData(samples);
          let sum = 0;
          for (const sample of samples) {
            const centered = (sample - 128) / 128;
            sum += centered * centered;
          }
          const rms = Math.sqrt(sum / samples.length);
          setAudioLevel(Math.min(1, rms * 4.5));
          frame = window.requestAnimationFrame(tick);
        };

        tick();
      } catch {
        setAudioLevel(0);
      }
    };

    startMeter();

    return () => {
      disposed = true;
      if (frame) window.cancelAnimationFrame(frame);
      stream?.getTracks().forEach((track) => track.stop());
      context?.close().catch(() => undefined);
    };
  }, [active, inputDeviceId, muted]);

  const saveOwnerTokens = (next: Record<string, string>) => {
    setOwnerTokens(next);
    localStorage.setItem('mipavoice.channelOwnerTokens', JSON.stringify(next));
  };

  const enterApp = () => {
    const clean = draftName.trim();
    if (!clean) return;
    localStorage.setItem('mipavoice.username', clean);
    setUsername(clean);
  };

  const createChannel = async () => {
    const name = createName.trim();
    if (!name) return;
    setLoading(true);
    setError(null);
    try {
      const created = await api.createChannel(name, createPassword, username);
      saveOwnerTokens({ ...ownerTokens, [created.id]: created.owner_token });
      setCreateName('');
      setCreatePassword('');
      setCreateOpen(false);
      await loadChannels();
    } catch (err) {
      setError(err instanceof Error ? err.message : '\u65e0\u6cd5\u521b\u5efa\u9891\u9053');
    } finally {
      setLoading(false);
    }
  };

  const deleteChannel = async (channel: Channel) => {
    const token = ownerTokens[channel.id];
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      if (active?.channel.id === channel.id) {
        await leaveCurrent();
      }
      await api.deleteChannel(channel.id, token);
      const next = { ...ownerTokens };
      delete next[channel.id];
      saveOwnerTokens(next);
      await loadChannels();
    } catch (err) {
      setError(err instanceof Error ? err.message : '\u65e0\u6cd5\u5220\u9664\u9891\u9053');
    } finally {
      setLoading(false);
    }
  };

  const joinChannel = async (channel: Channel, password?: string) => {
    if (!signedIn) return;
    if (joinLockRef.current) return;
    joinLockRef.current = true;
    setLoading(true);
    setError(null);
    try {
      await leaveCurrent(false);
      const joined = await api.joinChannel(channel.id, username, password);
      const voice = await connectVoice(joined.livekit_url, joined.token, setVoiceStatus, setActiveSpeakers, {
        inputDeviceId,
        outputDeviceId,
      });
      voiceRef.current = voice;
      setActive({ channel, sessionId: joined.session_id });
      playJoinSound();
      setMuted(false);
      setPasswordChannel(null);
      setJoinPassword('');
      await loadDevices();
    } catch (err) {
      setError(err instanceof Error ? err.message : '\u65e0\u6cd5\u52a0\u5165\u9891\u9053');
      setVoiceStatus(text.idle);
    } finally {
      joinLockRef.current = false;
      setLoading(false);
    }
  };

  const leaveCurrent = async (updateState = true) => {
    const current = active;
    const shouldPlaySound = Boolean(current);
    voiceRef.current?.disconnect();
    voiceRef.current = null;
    setAudioLevel(0);
    setActiveSpeakers([]);
    if (current) {
      await api.leaveChannel(current.channel.id, current.sessionId).catch(() => undefined);
    }
    if (updateState) {
      setActive(null);
      setVoiceStatus(text.idle);
    }
    if (shouldPlaySound) {
      playLeaveSound();
    }
  };

  const kickMember = async (member: Participant) => {
    if (!active || member.session_id === active.sessionId) return;
    const token = ownerTokens[active.channel.id];
    if (!token) return;
    await api.kickParticipant(active.channel.id, token, member.session_id).catch((err) => setError(err.message));
  };

  const sendChat = async () => {
    const body = chatDraft.trim();
    if (!active || !body) return;
    setChatDraft('');
    try {
      const message = await api.sendMessage(active.channel.id, active.sessionId, body);
      setChatMessages((current) => (current.some((item) => item.id === message.id) ? current : [...current, message]));
    } catch (err) {
      setError(err instanceof Error ? err.message : '\u65e0\u6cd5\u53d1\u9001\u6d88\u606f');
    }
  };

  const chooseInputDevice = async (deviceId: string) => {
    setInputDeviceId(deviceId);
    localStorage.setItem('mipavoice.inputDeviceId', deviceId);
    if (voiceRef.current) {
      await voiceRef.current.switchInput(deviceId || 'default').catch((err) => setError(err.message));
    }
  };

  const chooseOutputDevice = async (deviceId: string) => {
    setOutputDeviceId(deviceId);
    localStorage.setItem('mipavoice.outputDeviceId', deviceId);
    if (voiceRef.current) {
      await voiceRef.current.switchOutput(deviceId || 'default').catch(() => setError('\u5f53\u524d\u73af\u5883\u4e0d\u652f\u6301\u5207\u6362\u8f93\u51fa\u8bbe\u5907'));
    }
  };

  const setRemoteVolume = (identity: string, volume: number) => {
    const nextVolume = Math.max(0, Math.min(1, volume));
    setParticipantVolumes((current) => ({ ...current, [identity]: nextVolume }));
    voiceRef.current?.setParticipantVolume(identity, nextVolume);
  };

  const saveServerUrl = async () => {
    const clean = serverDraft.trim();
    if (active) {
      setError('\u5207\u6362\u670d\u52a1\u5668\u524d\u8bf7\u5148\u79bb\u5f00\u5f53\u524d\u9891\u9053');
      return;
    }

    localStorage.setItem('mipavoice.serverUrl', clean);
    setServerUrl(clean);
    setApiBaseUrl(clean);
    setMembers({});
    setError(null);
    try {
      await loadChannels();
      await refreshServerInfo();
      setError(clean ? `\u5df2\u5207\u6362\u5230 ${normalizeServerUrl(clean)}` : '\u5df2\u5207\u56de\u9ed8\u8ba4\u670d\u52a1\u5668');
    } catch (err) {
      setError(err instanceof Error ? err.message : '\u65e0\u6cd5\u8fde\u63a5\u5230\u670d\u52a1\u5668');
    }
  };

  const displayedChannels = useMemo(
    () =>
      [...channels].sort((a, b) => {
        if (a.id === active?.channel.id) return -1;
        if (b.id === active?.channel.id) return 1;
        return a.name.localeCompare(b.name);
      }),
    [active?.channel.id, channels],
  );

  if (!signedIn) {
    return (
      <main className="entry-screen">
        <section className="entry-panel" aria-labelledby="entry-title">
          <div className="brand-mark">
            <Headphones aria-hidden />
          </div>
          <h1 id="entry-title">MipaVoice</h1>
          <p>{text.entryHint}</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              enterApp();
            }}
          >
            <input value={draftName} onChange={(event) => setDraftName(event.target.value)} placeholder={text.username} maxLength={32} autoFocus />
            <button type="submit">{text.enter}</button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div>
            <span className="eyebrow">MipaVoice</span>
            <h1>{text.voiceChannels}</h1>
          </div>
          <button className="icon-button" title={text.refreshChannels} onClick={() => loadChannels()}>
            <RefreshCw size={18} />
          </button>
        </div>

        <button className="create-button" onClick={() => setCreateOpen(true)}>
          <Plus size={18} />
          {text.newChannel}
        </button>

        <nav className="channel-list" aria-label={text.voiceChannels}>
          {displayedChannels.map((channel) => (
            <div key={channel.id} className={`channel-row ${active?.channel.id === channel.id ? 'active' : ''}`}>
              <button
                className="channel-item"
                disabled={loading}
                onClick={() => {
                  if (loading) return;
                  if (channel.has_password) {
                    setPasswordChannel(channel);
                  } else {
                    void joinChannel(channel);
                  }
                }}
              >
                <span className="channel-main">
                  <Hash size={17} />
                  <span>{channel.name}</span>
                  {channel.has_password && <Lock size={14} />}
                </span>
                <span className="channel-count">
                  <Users size={14} />
                  {channel.member_count}
                </span>
              </button>
              {ownerTokens[channel.id] && (
                <button className="channel-delete" title={text.deleteChannel} disabled={loading} onClick={() => void deleteChannel(channel)}>
                  <Trash2 size={16} />
                </button>
              )}
            </div>
          ))}
          {displayedChannels.length === 0 && <div className="empty-state">{text.noChannels}</div>}
        </nav>

        <div className="profile-strip">
          <div>
            <span className="profile-name">{username}</span>
            <span className="profile-status">{voiceStatus}</span>
          </div>
          <div className="profile-actions">
            <button className="icon-button" title={text.settings} onClick={() => setSettingsOpen(true)}>
              <Settings size={18} />
            </button>
            <button
              className="icon-button"
              title={text.changeUsername}
              onClick={() => {
                void leaveCurrent();
                localStorage.removeItem('mipavoice.username');
                setUsername('');
                setDraftName('');
              }}
            >
              <LogOut size={18} />
            </button>
          </div>
        </div>
      </aside>

      <section className="room-view">
        <header className="room-header">
          <div>
            <span className="eyebrow">{text.currentChannel}</span>
            <h2>{active ? active.channel.name : text.notConnected}</h2>
          </div>
          <div className="connection-pill" title={`${serverInfo.label}\n${serverInfo.latency === null ? '\u5ef6\u8fdf\uff1a\u672a\u8fde\u63a5' : `\u5ef6\u8fdf\uff1a${serverInfo.latency} ms`}`}>
            <span className="server-flag">
              {serverInfo.countryCode ? (
                <img src={`https://flagcdn.com/24x18/${serverInfo.countryCode.toLowerCase()}.png`} alt={serverInfo.countryCode} />
              ) : (
                serverInfo.flag
              )}
            </span>
            <Radio size={16} />
            {voiceStatus}
            <div className="server-tooltip">
              <strong>
                <span className="server-flag">
                  {serverInfo.countryCode ? (
                    <img src={`https://flagcdn.com/24x18/${serverInfo.countryCode.toLowerCase()}.png`} alt={serverInfo.countryCode} />
                  ) : (
                    serverInfo.flag
                  )}
                </span>
                {serverInfo.label}
              </strong>
              <span>{serverInfo.latency === null ? '\u5ef6\u8fdf\uff1a\u672a\u8fde\u63a5' : `\u5ef6\u8fdf\uff1a${serverInfo.latency} ms`}</span>
            </div>
          </div>
        </header>

        <div className="members-area">
          <div className="member-list">
            <div className="list-heading">
              <Users size={18} />
              {text.members}
            </div>
            {activeMembers.map((member) => (
              <div className="member-row" key={member.session_id}>
                <span className={`avatar ${activeSpeakers.includes(member.username) ? 'speaking' : ''}`}>
                  {member.username.slice(0, 1).toUpperCase()}
                </span>
                <div className="member-body">
                  <div className="member-line">
                    <span>{member.username}</span>
                    {member.session_id === active?.sessionId && <span className="you-badge">{text.you}</span>}
                  </div>
                  {member.session_id !== active?.sessionId && (
                    <label className="member-volume">
                      <span>{text.localVolume}</span>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={Math.round((participantVolumes[member.username] ?? 1) * 100)}
                        onChange={(event) => setRemoteVolume(member.username, Number(event.target.value) / 100)}
                      />
                    </label>
                  )}
                </div>
                {active && ownerTokens[active.channel.id] && member.session_id !== active.sessionId && (
                  <button className="member-kick" title={text.kick} onClick={() => void kickMember(member)}>
                    <X size={15} />
                  </button>
                )}
              </div>
            ))}
            {activeMembers.length === 0 && (
              <div className="empty-state large">
                <Volume2 size={28} />
                {text.noMembers}
              </div>
            )}
          </div>
          <section className="chat-panel" aria-label={text.chat}>
            <div className="list-heading">
              <Hash size={18} />
              {text.chat}
            </div>
            <div className="chat-log">
              {chatMessages.map((message) => (
                <article className="chat-message" key={message.id}>
                  <header>
                    <strong>{message.username}</strong>
                    <time>{new Date(message.created_at).toLocaleString()}</time>
                  </header>
                  <p>{message.body}</p>
                </article>
              ))}
            </div>
            <form
              className="chat-form"
              onSubmit={(event) => {
                event.preventDefault();
                void sendChat();
              }}
            >
              <input
                value={chatDraft}
                onChange={(event) => setChatDraft(event.target.value)}
                placeholder={text.messagePlaceholder}
                disabled={!active}
                maxLength={2000}
              />
              <button className="primary-action" disabled={!active || !chatDraft.trim()}>
                {text.send}
              </button>
            </form>
          </section>
        </div>

        <footer className="voice-bar">
          <div className="voice-summary">
            <strong>{active ? active.channel.name : text.noActiveChannel}</strong>
            <span>{active ? `${activeMembers.length} ${text.online}` : text.chooseChannel}</span>
            <div className="level-meter" aria-label={text.meterLabel}>
              <span style={{ transform: `scaleX(${audioLevel})` }} />
            </div>
          </div>
          <div className="voice-actions">
            <button className={`round-button ${muted ? 'danger' : ''}`} title={muted ? text.unmute : text.mute} disabled={!active} onClick={() => setMuted((value) => !value)}>
              {muted ? <MicOff size={22} /> : <Mic size={22} />}
            </button>
            <button className="round-button hangup" title={text.hangup} disabled={!active} onClick={() => void leaveCurrent()}>
              <PhoneOff size={22} />
            </button>
          </div>
        </footer>
      </section>

      {createOpen && (
        <Dialog title={text.createChannel} onClose={() => setCreateOpen(false)}>
          <label>
            {text.channelName}
            <input value={createName} onChange={(event) => setCreateName(event.target.value)} autoFocus />
          </label>
          <label>
            {text.channelPassword}
            <input value={createPassword} onChange={(event) => setCreatePassword(event.target.value)} type="password" placeholder={text.optional} />
          </label>
          <button className="primary-action" disabled={loading} onClick={() => void createChannel()}>
            {text.create}
          </button>
        </Dialog>
      )}

      {passwordChannel && (
        <Dialog title={`${text.join} ${passwordChannel.name}`} onClose={() => setPasswordChannel(null)}>
          <label>
            {text.channelPassword}
            <input value={joinPassword} onChange={(event) => setJoinPassword(event.target.value)} type="password" autoFocus />
          </label>
          <button className="primary-action" disabled={loading || joinLockRef.current} onClick={() => void joinChannel(passwordChannel, joinPassword)}>
            {text.join}
          </button>
        </Dialog>
      )}

      {settingsOpen && (
        <Dialog title={text.settings} onClose={() => setSettingsOpen(false)}>
          <label>
            {text.server}
            <input value={serverDraft} onChange={(event) => setServerDraft(event.target.value)} placeholder={`\u7559\u7a7a\u4f7f\u7528\u9ed8\u8ba4\uff1a${DEFAULT_API_URL}`} />
          </label>
          <button className="secondary-action" onClick={() => void saveServerUrl()}>
            {text.saveServer}
          </button>
          <p className="settings-note">
            {text.currentConnection}：{serverUrl.trim() ? normalizeServerUrl(serverUrl) : `${DEFAULT_API_URL}\uff08${text.defaultServer}\uff09`}
          </p>
          <button className="secondary-action" onClick={() => void loadDevices()}>
            {text.refreshDevices}
          </button>
          <label>
            {text.inputDevice}
            <select value={inputDeviceId} onChange={(event) => void chooseInputDevice(event.target.value)}>
              <option value="">{text.defaultMic}</option>
              {devices.inputs.map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `${text.mic} ${index + 1}`}
                </option>
              ))}
            </select>
          </label>
          <label>
            {text.outputDevice}
            <select value={outputDeviceId} onChange={(event) => void chooseOutputDevice(event.target.value)}>
              <option value="">{text.defaultSpeaker}</option>
              {devices.outputs.map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `${text.speaker} ${index + 1}`}
                </option>
              ))}
            </select>
          </label>
          <p className="settings-note">{text.deviceNote}</p>
        </Dialog>
      )}

      {error && (
        <div className="toast" role="alert">
          {error}
          <button onClick={() => setError(null)}>{text.ok}</button>
        </div>
      )}

      <div id="audio-root" aria-hidden />
    </main>
  );
}

function Dialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="dialog" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <h3>{title}</h3>
          <button className="icon-button" title={text.close} onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="dialog-body">{children}</div>
      </section>
    </div>
  );
}
