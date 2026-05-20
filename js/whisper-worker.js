// Whisper Web Worker — runs in a separate thread so the UI stays responsive.
// Loaded as an ES module: new Worker('./js/whisper-worker.js', { type: 'module' })
//
// Messages IN  (from main thread):
//   { type: 'load',       data: { model: 'Xenova/whisper-tiny' } }
//   { type: 'transcribe', data: { audio: Float32Array } }        ← audio at 16 kHz mono
//
// Messages OUT (to main thread):
//   { type: 'progress', data: { status, progress, file, ... } }
//   { type: 'ready'   }
//   { type: 'result',  data: { text, chunks: [{text,timestamp}] } }
//   { type: 'error',   data: <string> }

// CDN — pin to major version 3; update the version if the API changes
import { pipeline, env } from
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/dist/transformers.min.js';

// Only use the remote Hugging Face hub; let Transformers.js handle browser caching
env.allowLocalModels  = false;
env.useBrowserCache   = true;

let transcriber   = null;
let loadedModel   = null;
let loadedGpuPref = null;

self.onmessage = async ({ data: msg }) => {
  switch (msg.type) {

    case 'load': {
      const { model, gpuPref = 'high-performance' } = msg.data;

      // Already loaded with same settings — nothing to do
      if (loadedModel === model && loadedGpuPref === gpuPref && transcriber) {
        self.postMessage({ type: 'ready', device: gpuPref === 'wasm' ? 'wasm' : 'webgpu' });
        return;
      }

      loadedModel   = model;
      loadedGpuPref = gpuPref;
      transcriber   = null;

      // Decide device — pre-check adapter BEFORE trying pipeline to avoid 90s stall.
      // navigator.gpu can exist on Linux but requestAdapter() returns null (no Vulkan driver).
      let gpuAdapter = null;
      const wantsWebGPU = gpuPref !== 'wasm' && 'gpu' in self.navigator;
      if (wantsWebGPU) {
        try {
          const pref = (gpuPref === 'auto') ? 'default' : gpuPref;
          gpuAdapter = await self.navigator.gpu.requestAdapter({ powerPreference: pref });
        } catch (_) { /* no WebGPU support */ }
      }
      const device = (wantsWebGPU && gpuAdapter) ? 'webgpu' : 'wasm';

      if (device === 'wasm' && wantsWebGPU) {
        // Inform main thread that no GPU adapter was found → using WASM
        self.postMessage({ type: 'progress',
          data: { status: 'info', message: 'Geen GPU-adapter gevonden, WASM (CPU) wordt gebruikt.' } });
      }

      // Patch requestAdapter so OUR powerPreference always wins.
      let origRequestAdapter = null;
      if (device === 'webgpu' && gpuPref !== 'auto') {
        origRequestAdapter = self.navigator.gpu.requestAdapter.bind(self.navigator.gpu);
        self.navigator.gpu.requestAdapter = (opts = {}) =>
          origRequestAdapter({ ...opts, powerPreference: gpuPref }); // gpuPref wins
      }

      // Report adapter info to main thread (already fetched above)
      if (gpuAdapter) {
        try {
          const info = await gpuAdapter.requestAdapterInfo();
          self.postMessage({ type: 'gpuInfo',
            data: { vendor: info.vendor || '', device: info.device || '', description: info.description || '' } });
        } catch (_) { /* non-fatal */ }
      }

      const progress_callback = p => self.postMessage({ type: 'progress', data: p });

      // WebGPU shader compilation can stall indefinitely on Linux — add a hard timeout.
      // Keep a 90s timeout as last-resort safety net (e.g. adapter exists but shaders stall)
      const WEBGPU_TIMEOUT = 90_000;
      function withTimeout(promise) {
        return Promise.race([
          promise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('WebGPU init timeout na 90s')), WEBGPU_TIMEOUT))
        ]);
      }

      try {
        const pipelinePromise = pipeline('automatic-speech-recognition', model,
          { device, progress_callback });
        transcriber = await (device === 'webgpu' ? withTimeout(pipelinePromise) : pipelinePromise);
        self.postMessage({ type: 'ready', device });
      } catch (err) {
        if (device === 'webgpu') {
          // WebGPU failed or timed out — fall back to WASM
          const reason = err.message.includes('timeout') ? 'WebGPU timeout, WASM…' : 'WebGPU mislukt, WASM…';
          self.postMessage({ type: 'progress', data: { status: 'info', message: reason } });
          try {
            transcriber = await pipeline('automatic-speech-recognition', model,
              { device: 'wasm', progress_callback });
            self.postMessage({ type: 'ready', device: 'wasm' });
          } catch (err2) {
            self.postMessage({ type: 'error', data: String(err2) });
          }
        } else {
          self.postMessage({ type: 'error', data: String(err) });
        }
      } finally {
        if (origRequestAdapter) self.navigator.gpu.requestAdapter = origRequestAdapter;
      }
      break;
    }

    case 'transcribe': {
      if (!transcriber) {
        self.postMessage({ type: 'error', data: 'Model nog niet geladen.' });
        return;
      }
      try {
        const { audio } = msg.data; // Float32Array at 16 kHz mono
        const result = await transcriber(audio, {
          language:          'french',
          task:              'transcribe',
          return_timestamps: 'word',   // word-level timestamps for future use
        });
        self.postMessage({ type: 'result', data: result });
      } catch (err) {
        self.postMessage({ type: 'error', data: String(err) });
      }
      break;
    }

    default:
      self.postMessage({ type: 'error', data: `Onbekend bericht: ${msg.type}` });
  }
};
