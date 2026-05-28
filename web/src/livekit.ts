import { Room, RoomEvent, Track } from 'livekit-client';
import type { RemoteParticipant, RemoteTrack, RemoteTrackPublication } from 'livekit-client';

export type VoiceConnection = {
  room: Room;
  disconnect: () => void;
  setMuted: (muted: boolean) => Promise<void>;
  setParticipantVolume: (identity: string, volume: number) => void;
  switchInput: (deviceId: string) => Promise<void>;
  switchOutput: (deviceId: string) => Promise<void>;
};

export async function connectVoice(
  url: string,
  token: string,
  onStatus: (status: string) => void,
  onActiveSpeakers?: (identities: string[]) => void,
  devices?: { inputDeviceId?: string; outputDeviceId?: string },
): Promise<VoiceConnection> {
  const room = new Room({
    adaptiveStream: true,
    dynacast: true,
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
  await room.localParticipant.setMicrophoneEnabled(true);
  if (devices?.inputDeviceId) {
    await room.switchActiveDevice('audioinput', devices.inputDeviceId);
  }

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
      await room.localParticipant.setMicrophoneEnabled(!muted);
    },
    setParticipantVolume: (identity: string, volume: number) => {
      const nextVolume = Math.max(0, Math.min(1, volume));
      participantVolumes.set(identity, nextVolume);
      for (const element of attached.values()) {
        if (element.dataset.participantIdentity === identity) {
          element.volume = nextVolume;
        }
      }
    },
    switchInput: async (deviceId: string) => {
      await room.switchActiveDevice('audioinput', deviceId);
    },
    switchOutput: async (deviceId: string) => {
      await room.switchActiveDevice('audiooutput', deviceId);
    },
  };
}
