import createRNNWasmModuleSync from '@jitsi/rnnoise-wasm/dist/rnnoise-sync.js';

const FRAME_SIZE = 480;
const PCM_SCALE = 32768;

class MipaVoiceRnnoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.module = createRNNWasmModuleSync();
    this.state = this.module._rnnoise_create(0);
    this.inputFrame = new Float32Array(FRAME_SIZE);
    this.outputFrame = new Float32Array(FRAME_SIZE);
    this.inputIndex = 0;
    this.outputIndex = FRAME_SIZE;
    this.framePointer = this.module._malloc(FRAME_SIZE * Float32Array.BYTES_PER_ELEMENT);
    this.frameHeapIndex = this.framePointer / Float32Array.BYTES_PER_ELEMENT;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const outputChannel = output[0];

    if (!outputChannel) {
      return true;
    }

    const inputChannelCount = input?.length ?? 0;
    const sampleCount = outputChannel.length;

    for (let index = 0; index < sampleCount; index += 1) {
      let sample = 0;

      if (inputChannelCount > 0) {
        for (let channel = 0; channel < inputChannelCount; channel += 1) {
          sample += input[channel]?.[index] ?? 0;
        }
        sample /= inputChannelCount;
      }

      this.inputFrame[this.inputIndex] = sample;
      this.inputIndex += 1;

      if (this.inputIndex === FRAME_SIZE) {
        this.processFrame();
        this.inputIndex = 0;
        this.outputIndex = 0;
      }

      outputChannel[index] = this.outputIndex < FRAME_SIZE ? this.outputFrame[this.outputIndex] : 0;
      this.outputIndex += 1;
    }

    for (let channel = 1; channel < output.length; channel += 1) {
      output[channel].set(outputChannel);
    }

    return true;
  }

  processFrame() {
    const heap = this.module.HEAPF32;

    for (let index = 0; index < FRAME_SIZE; index += 1) {
      heap[this.frameHeapIndex + index] = this.inputFrame[index] * PCM_SCALE;
    }

    this.module._rnnoise_process_frame(this.state, this.framePointer, this.framePointer);

    for (let index = 0; index < FRAME_SIZE; index += 1) {
      const sample = heap[this.frameHeapIndex + index] / PCM_SCALE;
      this.outputFrame[index] = Math.max(-1, Math.min(1, sample));
    }
  }
}

registerProcessor('mipavoice-rnnoise', MipaVoiceRnnoiseProcessor);
