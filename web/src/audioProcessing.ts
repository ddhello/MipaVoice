import { Track } from 'livekit-client';
import type { AudioProcessorOptions, TrackProcessor } from 'livekit-client';

type AudioNodeChain = {
  source: MediaStreamAudioSourceNode;
  highPass: BiquadFilterNode;
  lowPass: BiquadFilterNode;
  rnnoise?: AudioWorkletNode;
  gate: ScriptProcessorNode;
  destination: MediaStreamAudioDestinationNode;
};

const PROCESSOR_NAME = 'mipavoice-keyboard-noise-suppression';
const rnnoiseWorkletUrl = new URL('./rnnoiseWorklet.js', import.meta.url);
const rnnoiseModulePromises = new WeakMap<AudioContext, Promise<void>>();

export type KeyboardNoiseProcessor = TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> & {
  readonly rnnoiseActive: boolean;
  readonly rnnoiseError?: string;
};

function loadRnnoiseWorklet(audioContext: AudioContext) {
  if (!audioContext.audioWorklet) {
    return Promise.reject(new Error('AudioWorklet is not supported'));
  }

  let promise = rnnoiseModulePromises.get(audioContext);
  if (!promise) {
    promise = audioContext.audioWorklet.addModule(rnnoiseWorkletUrl);
    rnnoiseModulePromises.set(audioContext, promise);
  }
  return promise;
}

export function createKeyboardNoiseProcessor(useRnnoise = true, keyboardNoiseThreshold = 50): KeyboardNoiseProcessor {
  let chain: AudioNodeChain | null = null;
  let processedTrack: MediaStreamTrack | undefined;
  let gateGain = 0;
  let holdFrames = 0;
  let noiseFloor = 0.008;
  let rnnoiseError: string | undefined;
  let ownedAudioContext: AudioContext | undefined;
  const threshold = Math.max(0, Math.min(100, keyboardNoiseThreshold)) / 100;
  const clickPeakThreshold = 0.006 + threshold * 0.036;
  const clickRmsCeiling = 0.24 - threshold * 0.14;
  const clickZeroCrossingThreshold = 0.16 + threshold * 0.12;
  const clickCrestFactorThreshold = 4.2 + threshold * 3;

  const destroy = async () => {
    if (processedTrack) {
      processedTrack.stop();
      processedTrack = undefined;
    }

    if (chain) {
      chain.gate.onaudioprocess = null;
      chain.source.disconnect();
      chain.highPass.disconnect();
      chain.lowPass.disconnect();
      chain.rnnoise?.disconnect();
      chain.gate.disconnect();
      chain.destination.disconnect();
      chain = null;
    }
    await ownedAudioContext?.close().catch(() => undefined);
    ownedAudioContext = undefined;
  };

  const init = async ({ audioContext, track }: AudioProcessorOptions) => {
    await destroy();

    track.contentHint = 'speech';

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const context = audioContext ?? new AudioContextClass({ latencyHint: 'interactive' });
    if (!audioContext) {
      ownedAudioContext = context;
    }
    const inputStream = new MediaStream([track]);
    const source = context.createMediaStreamSource(inputStream);
    const highPass = context.createBiquadFilter();
    highPass.type = 'highpass';
    highPass.frequency.value = 130;
    highPass.Q.value = 0.7;

    const lowPass = context.createBiquadFilter();
    lowPass.type = 'lowpass';
    lowPass.frequency.value = 4200;
    lowPass.Q.value = 0.65;

    let rnnoise: AudioWorkletNode | undefined;
    if (useRnnoise) {
      try {
        await loadRnnoiseWorklet(context);
        rnnoise = new AudioWorkletNode(context, 'mipavoice-rnnoise', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        });
        rnnoiseError = undefined;
      } catch (error) {
        rnnoiseError = error instanceof Error ? error.message : 'RNNoise failed to load';
        rnnoise = undefined;
      }
    } else {
      rnnoiseError = undefined;
    }

    const gate = context.createScriptProcessor(1024, 1, 1);
    const destination = context.createMediaStreamDestination();

    gate.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const output = event.outputBuffer.getChannelData(0);
      let sum = 0;
      let peak = 0;
      let zeroCrossings = 0;
      let previous = input[0] ?? 0;

      for (let index = 0; index < input.length; index += 1) {
        const sample = input[index] ?? 0;
        const abs = Math.abs(sample);
        sum += sample * sample;
        peak = Math.max(peak, abs);
        if ((sample >= 0 && previous < 0) || (sample < 0 && previous >= 0)) {
          zeroCrossings += 1;
        }
        previous = sample;
      }

      const rms = Math.sqrt(sum / input.length);
      const zeroCrossingRate = zeroCrossings / input.length;
      const crestFactor = peak / Math.max(rms, 0.0001);
      if (rms < noiseFloor * 1.8) {
        noiseFloor = noiseFloor * 0.995 + rms * 0.005;
      }

      const openThreshold = Math.max(0.018, noiseFloor * 3.2);
      const likelyKeyboardClick =
        holdFrames === 0 &&
        peak > clickPeakThreshold &&
        rms < clickRmsCeiling &&
        (zeroCrossingRate > clickZeroCrossingThreshold || crestFactor > clickCrestFactorThreshold);
      const shouldOpen = rms > openThreshold && !likelyKeyboardClick;

      if (shouldOpen) {
        holdFrames = 12;
      } else if (holdFrames > 0) {
        holdFrames -= 1;
      }

      const targetGain = holdFrames > 0 ? 1 : likelyKeyboardClick ? 0.015 : 0.05;
      const smoothing = targetGain > gateGain ? 0.35 : likelyKeyboardClick ? 0.22 : 0.08;
      gateGain += (targetGain - gateGain) * smoothing;

      for (let index = 0; index < input.length; index += 1) {
        output[index] = (input[index] ?? 0) * gateGain;
      }
    };

    source.connect(highPass);
    highPass.connect(lowPass);
    if (rnnoise) {
      lowPass.connect(rnnoise);
      rnnoise.connect(gate);
    } else {
      lowPass.connect(gate);
    }
    gate.connect(destination);

    chain = { source, highPass, lowPass, rnnoise, gate, destination };
    processedTrack = destination.stream.getAudioTracks()[0];
    if (processedTrack) {
      processedTrack.contentHint = 'speech';
    }
  };

  return {
    name: PROCESSOR_NAME,
    get processedTrack() {
      return processedTrack;
    },
    get rnnoiseActive() {
      return Boolean(chain?.rnnoise);
    },
    get rnnoiseError() {
      return rnnoiseError;
    },
    init,
    restart: init,
    destroy,
  };
}

export function isKeyboardNoiseProcessor(
  processor?: TrackProcessor<Track.Kind.Audio, AudioProcessorOptions>,
): processor is KeyboardNoiseProcessor {
  return processor?.name === PROCESSOR_NAME;
}
