import { Room, RoomEvent, Track } from 'livekit-client';
import type { RemoteTrack, RemoteTrackPublication, RemoteParticipant } from 'livekit-client';

export type VoiceConnection = {
  room: Room;
  disconnect: () => void;
  setMuted: (muted: boolean) => Promise<void>;
  switchInput: (deviceId: string) => Promise<void>;
  switchOutput: (deviceId: string) => Promise<void>;
};

export async function connectVoice(
  url: string,
  token: string,
  onStatus: (status: string) => void,
  devices?: { inputDeviceId?: string; outputDeviceId?: string },
): Promise<VoiceConnection> {
  const room = new Room({
    adaptiveStream: true,
    dynacast: true,
  });

  const audioRoot = document.getElementById('audio-root');
  const attached = new Map<string, HTMLMediaElement>();

  const attachAudio = (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => {
    if (track.kind !== Track.Kind.Audio || !audioRoot) return;
    const key = `${participant.identity}:${publication.trackSid}`;
    const element = track.attach();
    element.dataset.trackKey = key;
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
    .on(RoomEvent.Connected, () => onStatus('已连接'))
    .on(RoomEvent.Reconnecting, () => onStatus('正在重连'))
    .on(RoomEvent.Reconnected, () => onStatus('已连接'))
    .on(RoomEvent.Disconnected, () => onStatus('已断开'))
    .on(RoomEvent.TrackSubscribed, attachAudio)
    .on(RoomEvent.TrackUnsubscribed, detachAudio);

  onStatus('正在连接');
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
    switchInput: async (deviceId: string) => {
      await room.switchActiveDevice('audioinput', deviceId);
    },
    switchOutput: async (deviceId: string) => {
      await room.switchActiveDevice('audiooutput', deviceId);
    },
  };
}
