import { Track } from 'livekit-client';
import type { AudioProcessorOptions, TrackProcessor } from 'livekit-client';

type AudioNodeChain = {
  source: MediaStreamAudioSourceNode;
  highPass: BiquadFilterNode;
  lowPass: BiquadFilterNode;
  compressor: DynamicsCompressorNode;
  rnnoise?: AudioWorkletNode;
  gate: ScriptProcessorNode;
  destination: MediaStreamAudioDestinationNode;
};

const PROCESSOR_NAME = 'mipavoice-keyboard-noise-suppression';
const rnnoiseWorkletUrl = new URL('./rnnoiseWorklet.js', import.meta.url);
const rnnoiseModulePromises = new WeakMap<AudioContext, Promise<void>>();

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

export function createKeyboardNoiseProcessor(): TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  let chain: AudioNodeChain | null = null;
  let processedTrack: MediaStreamTrack | undefined;
  let gateGain = 0;
  let holdFrames = 0;
  let noiseFloor = 0.008;

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
      chain.compressor.disconnect();
      chain.rnnoise?.disconnect();
      chain.gate.disconnect();
      chain.destination.disconnect();
      chain = null;
    }
  };

  const init = async ({ audioContext, track }: AudioProcessorOptions) => {
    await destroy();

    track.contentHint = 'speech';

    const inputStream = new MediaStream([track]);
    const source = audioContext.createMediaStreamSource(inputStream);
    const highPass = audioContext.createBiquadFilter();
    highPass.type = 'highpass';
    highPass.frequency.value = 130;
    highPass.Q.value = 0.7;

    const lowPass = audioContext.createBiquadFilter();
    lowPass.type = 'lowpass';
    lowPass.frequency.value = 4200;
    lowPass.Q.value = 0.65;

    const compressor = audioContext.createDynamicsCompressor();
    compressor.threshold.value = -34;
    compressor.knee.value = 16;
    compressor.ratio.value = 8;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.18;

    let rnnoise: AudioWorkletNode | undefined;
    try {
      await loadRnnoiseWorklet(audioContext);
      rnnoise = new AudioWorkletNode(audioContext, 'mipavoice-rnnoise', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
    } catch {
      rnnoise = undefined;
    }

    const gate = audioContext.createScriptProcessor(1024, 1, 1);
    const destination = audioContext.createMediaStreamDestination();

    gate.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const output = event.outputBuffer.getChannelData(0);
      let sum = 0;
      let zeroCrossings = 0;
      let previous = input[0] ?? 0;

      for (let index = 0; index < input.length; index += 1) {
        const sample = input[index] ?? 0;
        sum += sample * sample;
        if ((sample >= 0 && previous < 0) || (sample < 0 && previous >= 0)) {
          zeroCrossings += 1;
        }
        previous = sample;
      }

      const rms = Math.sqrt(sum / input.length);
      const zeroCrossingRate = zeroCrossings / input.length;
      if (rms < noiseFloor * 1.8) {
        noiseFloor = noiseFloor * 0.995 + rms * 0.005;
      }

      const openThreshold = Math.max(0.018, noiseFloor * 3.2);
      const likelyKeyboardClick = zeroCrossingRate > 0.22 && rms < 0.075 && holdFrames === 0;
      const shouldOpen = rms > openThreshold && !likelyKeyboardClick;

      if (shouldOpen) {
        holdFrames = 12;
      } else if (holdFrames > 0) {
        holdFrames -= 1;
      }

      const targetGain = holdFrames > 0 ? 1 : 0.08;
      const smoothing = targetGain > gateGain ? 0.35 : 0.08;
      gateGain += (targetGain - gateGain) * smoothing;

      for (let index = 0; index < input.length; index += 1) {
        output[index] = (input[index] ?? 0) * gateGain;
      }
    };

    source.connect(highPass);
    highPass.connect(lowPass);
    lowPass.connect(compressor);
    if (rnnoise) {
      compressor.connect(rnnoise);
      rnnoise.connect(gate);
    } else {
      compressor.connect(gate);
    }
    gate.connect(destination);

    chain = { source, highPass, lowPass, compressor, rnnoise, gate, destination };
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
    init,
    restart: init,
    destroy,
  };
}

export function isKeyboardNoiseProcessor(processor?: TrackProcessor<Track.Kind.Audio, AudioProcessorOptions>) {
  return processor?.name === PROCESSOR_NAME;
}
