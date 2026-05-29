import { Room, RoomEvent, Track } from 'livekit-client';
import type { AudioCaptureOptions, RemoteParticipant, RemoteTrack, RemoteTrackPublication } from 'livekit-client';

export type VoiceConnection = {
  room: Room;
  disconnect: () => void;
  setMuted: (muted: boolean) => Promise<void>;
  setParticipantVolume: (identity: string, volume: number) => void;
  switchInput: (deviceId: string) => Promise<void>;
  switchOutput: (deviceId: string) => Promise<void>;
  setKeyboardNoiseSuppression: (enabled: boolean, inputDeviceId?: string) => Promise<void>;
};

export function getAudioCaptureOptions(inputDeviceId?: string, keyboardNoiseSuppression = true): AudioCaptureOptions {
  return {
    deviceId: inputDeviceId ? { exact: inputDeviceId } : { ideal: 'default' },
    autoGainControl: keyboardNoiseSuppression,
    echoCancellation: keyboardNoiseSuppression,
    noiseSuppression: keyboardNoiseSuppression,
    voiceIsolation: keyboardNoiseSuppression,
  };
}

export async function connectVoice(
  url: string,
  token: string,
  onStatus: (status: string) => void,
  onActiveSpeakers?: (identities: string[]) => void,
  devices?: { inputDeviceId?: string; outputDeviceId?: string; keyboardNoiseSuppression?: boolean },
): Promise<VoiceConnection> {
  let currentInputDeviceId = devices?.inputDeviceId ?? '';
  let keyboardNoiseSuppression = devices?.keyboardNoiseSuppression ?? true;
  let currentMuted = false;
  const room = new Room({
    adaptiveStream: true,
    dynacast: true,
    webAudioMix: true,
    audioCaptureDefaults: getAudioCaptureOptions(currentInputDeviceId, keyboardNoiseSuppression),
  });

  const audioRoot = document.getElementById('audio-root');
  const attached = new Map<string, HTMLMediaElement>();
  const participantVolumes = new Map<string, number>();

  const attachAudio = (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => {
    if (track.kind !== Track.Kind.Audio || !audioRoot) return;
    const key = `${participant.identity}:${publication.trackSid}`;
    const element = track.attach();
    element.dataset.trackKey = key;
    element.dataset.participantIdentity = participant.identity;
    element.volume = participantVolumes.get(participant.identity) ?? 1;
    element.autoplay = true;
    attached.set(key, element);
    audioRoot.appendChild(element);
  };

  const detachAudio = (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => {
    const key = `${participant.identity}:${publication.trackSid}`;
    const element = attached.get(key);
    if (element) {
      track.detach(element);
      element.remove();
      attached.delete(key);
    }
  };

  room
    .on(RoomEvent.Connected, () => onStatus('\u5df2\u8fde\u63a5'))
    .on(RoomEvent.Reconnecting, () => onStatus('\u6b63\u5728\u91cd\u8fde'))
    .on(RoomEvent.Reconnected, () => onStatus('\u5df2\u8fde\u63a5'))
    .on(RoomEvent.Disconnected, () => onStatus('\u5df2\u65ad\u5f00'))
    .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      onActiveSpeakers?.(speakers.map((speaker) => speaker.identity));
    })
    .on(RoomEvent.TrackSubscribed, attachAudio)
    .on(RoomEvent.TrackUnsubscribed, detachAudio);

  onStatus('\u6b63\u5728\u8fde\u63a5');
  await room.connect(url, token);
  if (devices?.outputDeviceId) {
    await room.switchActiveDevice('audiooutput', devices.outputDeviceId).catch(() => undefined);
  }
  await room.localParticipant.setMicrophoneEnabled(
    true,
    getAudioCaptureOptions(currentInputDeviceId, keyboardNoiseSuppression),
  );

  return {
    room,
    disconnect: () => {
      for (const element of attached.values()) {
        element.remove();
      }
      attached.clear();
      room.disconnect();
    },
    setMuted: async (muted: boolean) => {
      currentMuted = muted;
      await room.localParticipant.setMicrophoneEnabled(
        !muted,
        getAudioCaptureOptions(currentInputDeviceId, keyboardNoiseSuppression),
      );
    },
    setParticipantVolume: (identity: string, volume: number) => {
      const nextVolume = Math.max(0, Math.min(5, volume));
      participantVolumes.set(identity, nextVolume);
      room.remoteParticipants.get(identity)?.setVolume(nextVolume);
      for (const element of attached.values()) {
        if (element.dataset.participantIdentity === identity) {
          element.volume = Math.min(1, nextVolume);
        }
      }
    },
    switchInput: async (deviceId: string) => {
      currentInputDeviceId = deviceId === 'default' ? '' : deviceId;
      await room.switchActiveDevice('audioinput', deviceId || 'default');
      await room.localParticipant.setMicrophoneEnabled(
        !currentMuted,
        getAudioCaptureOptions(currentInputDeviceId, keyboardNoiseSuppression),
      );
    },
    switchOutput: async (deviceId: string) => {
      await room.switchActiveDevice('audiooutput', deviceId);
    },
    setKeyboardNoiseSuppression: async (enabled: boolean, inputDeviceId?: string) => {
      keyboardNoiseSuppression = enabled;
      currentInputDeviceId = inputDeviceId ?? currentInputDeviceId;
      await room.localParticipant.setMicrophoneEnabled(
        !currentMuted,
        getAudioCaptureOptions(currentInputDeviceId, keyboardNoiseSuppression),
      );
    },
  };
}
