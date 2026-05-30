import { createKeyboardNoiseProcessor, isKeyboardNoiseProcessor, TrackProcessor } from './audioProcessing';
import { getApiBaseUrl } from './api';

type SfuSignal =
  | { type: 'answer'; sdp: string }
  | { type: 'offer'; sdp: string }
  | { type: 'candidate'; candidate: RTCIceCandidateInit }
  | { type: 'active-speakers'; identities: string[] }
  | { type: 'participant-left'; identity: string };

export type VoiceConnection = {
  disconnect: () => void;
  setMuted: (muted: boolean) => Promise<void>;
  setParticipantVolume: (identity: string, volume: number) => void;
  switchInput: (deviceId: string) => Promise<void>;
  switchOutput: (deviceId: string) => Promise<void>;
  setKeyboardNoiseSuppression: (enabled: boolean, inputDeviceId?: string) => Promise<void>;
  setAiNoiseSuppression: (enabled: boolean) => Promise<void>;
  setKeyboardNoiseThreshold: (threshold: number) => Promise<void>;
  getPublishedMicrophoneTrack: () => MediaStreamTrack | undefined;
};

export function getAudioCaptureOptions(
  inputDeviceId?: string,
  keyboardNoiseSuppression = true,
  includeProcessor = true,
  aiNoiseSuppression = true,
  keyboardNoiseThreshold = 50,
): MediaTrackConstraints {
  return {
    deviceId: inputDeviceId ? { exact: inputDeviceId } : { ideal: 'default' },
    autoGainControl: false,
    channelCount: { ideal: 1 },
    echoCancellation: keyboardNoiseSuppression,
    latency: { ideal: 0.02 },
    noiseSuppression: keyboardNoiseSuppression,
    sampleRate: { ideal: 48000 },
    sampleSize: { ideal: 16 },
    voiceIsolation: keyboardNoiseSuppression,
    googAudioMirroring: false,
    googAutoGainControl: false,
    googAutoGainControl2: false,
    googEchoCancellation: keyboardNoiseSuppression,
    googEchoCancellation2: keyboardNoiseSuppression,
    googHighpassFilter: keyboardNoiseSuppression,
    googNoiseSuppression: keyboardNoiseSuppression,
    googNoiseSuppression2: keyboardNoiseSuppression,
    googTypingNoiseDetection: keyboardNoiseSuppression,
    typingNoiseDetection: keyboardNoiseSuppression,
    mipavoiceProcessor:
      keyboardNoiseSuppression && includeProcessor
        ? { aiNoiseSuppression, keyboardNoiseThreshold }
        : undefined,
  } as MediaTrackConstraints;
}

function signalingUrl(url: string, token: string) {
  const parsed = new URL(url, getApiBaseUrl());
  parsed.protocol = parsed.protocol.replace(/^http/, 'ws');
  parsed.searchParams.set('token', token);
  return parsed.toString();
}

function waitForSocket(socket: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error('无法连接到自研 SFU'));
  });
}

function waitForAnswer(peer: RTCPeerConnection) {
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error('自研 SFU 未返回媒体协商结果')), 10000);
    const checkState = () => {
      if (peer.remoteDescription?.type === 'answer') {
        window.clearTimeout(timeout);
        resolve();
      }
    };
    peer.addEventListener('signalingstatechange', checkState);
    checkState();
  });
}

export async function connectVoice(
  url: string,
  token: string,
  onStatus: (status: string) => void,
  onActiveSpeakers?: (identities: string[]) => void,
  devices?: {
    inputDeviceId?: string;
    outputDeviceId?: string;
    keyboardNoiseSuppression?: boolean;
    aiNoiseSuppression?: boolean;
    keyboardNoiseThreshold?: number;
    iceServers?: RTCIceServer[];
  },
): Promise<VoiceConnection> {
  let currentInputDeviceId = devices?.inputDeviceId ?? '';
  let keyboardNoiseSuppression = devices?.keyboardNoiseSuppression ?? true;
  let aiNoiseSuppression = devices?.aiNoiseSuppression ?? true;
  let keyboardNoiseThreshold = devices?.keyboardNoiseThreshold ?? 50;
  let currentMuted = false;
  let localRawTrack: MediaStreamTrack | undefined;
  let localPublishedTrack: MediaStreamTrack | undefined;
  let processor: TrackProcessor | undefined;
  let currentOutputDeviceId = devices?.outputDeviceId ?? '';

  const audioRoot = document.getElementById('audio-root');
  const attached = new Map<string, HTMLMediaElement>();
  const participantVolumes = new Map<string, number>();
  let closing = false;
  let keepaliveTimer: number | undefined;
  const peer = new RTCPeerConnection({
    bundlePolicy: 'max-bundle',
    iceServers: devices?.iceServers ?? [{ urls: 'stun:stun.l.google.com:19302' }],
    rtcpMuxPolicy: 'require',
  });
  const socket = new WebSocket(signalingUrl(url, token));

  const sendSignal = (message: object) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(message));
  };

  const setElementOutput = async (element: HTMLMediaElement) => {
    if (!currentOutputDeviceId || !('setSinkId' in element)) return;
    await (element as HTMLMediaElement & { setSinkId: (deviceId: string) => Promise<void> })
      .setSinkId(currentOutputDeviceId)
      .catch(() => undefined);
  };

  const cleanupProcessor = async () => {
    await processor?.destroy().catch(() => undefined);
    processor = undefined;
  };

  const buildMicrophoneTrack = async () => {
    await cleanupProcessor();
    localRawTrack?.stop();

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: getAudioCaptureOptions(currentInputDeviceId, keyboardNoiseSuppression, false),
      video: false,
    });
    localRawTrack = stream.getAudioTracks()[0];
    if (!localRawTrack) {
      throw new Error('未找到可用的麦克风');
    }
    localRawTrack.contentHint = 'speech';

    if (!keyboardNoiseSuppression) {
      localPublishedTrack = localRawTrack;
      localPublishedTrack.enabled = !currentMuted;
      return localPublishedTrack;
    }

    processor = createKeyboardNoiseProcessor(aiNoiseSuppression, keyboardNoiseThreshold);
    await processor.init({ track: localRawTrack });
    localPublishedTrack = processor.processedTrack ?? localRawTrack;
    localPublishedTrack.contentHint = 'speech';
    localPublishedTrack.enabled = !currentMuted;
    return localPublishedTrack;
  };

  const replacePublishedTrack = async () => {
    const nextTrack = await buildMicrophoneTrack();
    const sender = peer.getSenders().find((item) => item.track?.kind === 'audio');
    if (sender) {
      await sender.replaceTrack(nextTrack);
    } else {
      peer.addTrack(nextTrack, new MediaStream([nextTrack]));
    }
  };

  socket.onmessage = async (event) => {
    const message = JSON.parse(event.data) as SfuSignal;
    if (message.type === 'answer') {
      await peer.setRemoteDescription({ type: 'answer', sdp: message.sdp });
    } else if (message.type === 'offer') {
      await peer.setRemoteDescription({ type: 'offer', sdp: message.sdp });
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      sendSignal({ type: 'answer', sdp: answer.sdp });
    } else if (message.type === 'candidate') {
      await peer.addIceCandidate(message.candidate).catch(() => undefined);
    } else if (message.type === 'active-speakers') {
      onActiveSpeakers?.(message.identities);
    } else if (message.type === 'participant-left') {
      for (const [key, element] of attached) {
        if (element.dataset.participantIdentity === message.identity) {
          element.remove();
          attached.delete(key);
        }
      }
    }
  };

  peer.onicecandidate = (event) => {
    if (event.candidate && socket.readyState === WebSocket.OPEN) {
      sendSignal({ type: 'candidate', candidate: event.candidate.toJSON() });
    }
  };

  peer.onconnectionstatechange = () => {
    if (peer.connectionState === 'connected') onStatus('已连接');
    if (peer.connectionState === 'connecting') onStatus('正在连接');
    if (peer.connectionState === 'disconnected' || peer.connectionState === 'failed') onStatus('已断开');
  };

  socket.onclose = () => {
    if (!closing && peer.connectionState !== 'connected') {
      onStatus('已断开');
    }
  };

  peer.ontrack = (event) => {
    if (!audioRoot || event.track.kind !== 'audio') return;

    const stream = event.streams[0] ?? new MediaStream([event.track]);
    const identity = stream.id || event.transceiver.mid || event.track.id;
    const element = document.createElement('audio');
    element.dataset.trackKey = event.track.id;
    element.dataset.participantIdentity = identity;
    element.srcObject = stream;
    element.volume = participantVolumes.get(identity) ?? 1;
    element.autoplay = true;
    attached.set(event.track.id, element);
    audioRoot.appendChild(element);
    void setElementOutput(element);
  };

  onStatus('正在连接');
  await waitForSocket(socket);
  keepaliveTimer = window.setInterval(() => sendSignal({ type: 'ping' }), 10000);
  const microphoneTrack = await buildMicrophoneTrack();
  peer.addTrack(microphoneTrack, new MediaStream([microphoneTrack]));
  peer.addTransceiver('audio', { direction: 'recvonly' });

  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  sendSignal({ type: 'offer', sdp: offer.sdp });
  await waitForAnswer(peer);

  return {
    disconnect: () => {
      closing = true;
      if (keepaliveTimer !== undefined) {
        window.clearInterval(keepaliveTimer);
      }
      for (const element of attached.values()) {
        element.remove();
      }
      attached.clear();
      sendSignal({ type: 'disconnect' });
      socket.close();
      peer.close();
      localRawTrack?.stop();
      if (localPublishedTrack !== localRawTrack) localPublishedTrack?.stop();
      void cleanupProcessor();
    },
    setMuted: async (muted: boolean) => {
      currentMuted = muted;
      if (localPublishedTrack) localPublishedTrack.enabled = !muted;
      if (localRawTrack) localRawTrack.enabled = !muted;
    },
    setParticipantVolume: (identity: string, volume: number) => {
      const nextVolume = Math.max(0, Math.min(5, volume));
      participantVolumes.set(identity, nextVolume);
      for (const element of attached.values()) {
        if (element.dataset.participantIdentity === identity) {
          element.volume = Math.min(1, nextVolume);
        }
      }
    },
    switchInput: async (deviceId: string) => {
      currentInputDeviceId = deviceId === 'default' ? '' : deviceId;
      await replacePublishedTrack();
    },
    switchOutput: async (deviceId: string) => {
      currentOutputDeviceId = deviceId === 'default' ? '' : deviceId;
      await Promise.all([...attached.values()].map(setElementOutput));
    },
    setKeyboardNoiseSuppression: async (enabled: boolean, inputDeviceId?: string) => {
      keyboardNoiseSuppression = enabled;
      currentInputDeviceId = inputDeviceId ?? currentInputDeviceId;
      if (!enabled && isKeyboardNoiseProcessor(processor)) {
        await processor.destroy();
        processor = undefined;
      }
      await replacePublishedTrack();
    },
    setAiNoiseSuppression: async (enabled: boolean) => {
      aiNoiseSuppression = enabled;
      if (keyboardNoiseSuppression) {
        await replacePublishedTrack();
      }
    },
    setKeyboardNoiseThreshold: async (threshold: number) => {
      keyboardNoiseThreshold = Math.max(0, Math.min(100, threshold));
      if (keyboardNoiseSuppression) {
        await replacePublishedTrack();
      }
    },
    getPublishedMicrophoneTrack: () => localPublishedTrack,
  };
}
