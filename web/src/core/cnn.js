/**
 * CNN channel: on-device inference for the two trained models.
 *
 *  M-Q  capture quality classifier (6 classes) - feeds the quality gate
 *  M-S  symmetry score regressor (0-100)       - the CNN channel of the fusion
 *
 * Both run locally through onnxruntime-web (WASM). Nothing is uploaded.
 *
 * Model files and the ONNX Runtime wasm are served from our own origin
 * (web/public/...), never a CDN, so the app works offline.
 *
 * 2026-10-02 (seventh revision) - WHY THE AI CHANNEL NEVER RAN ON THE DEVICE.
 *   The device said "AI 通道未参与本次评估" on every capture. Reproduced with
 *   web/__probe under simulated asset-loader conditions: loadModels() failed in
 *   9 ms, which is not a timeout - it is an immediate refusal.
 *
 *   onnxruntime-web loads its own glue file with a dynamic import():
 *       Nn = async (e) => (await import(e)).default
 *   Android's asset loader serves .mjs with a guessed Content-Type (often null),
 *   and Chromium refuses to execute a module script with the wrong MIME type.
 *   That is the SAME failure that kept the MediaPipe model from loading.
 *
 *   So, exactly as in landmarks.js: fetch the bytes ourselves and hand ORT blob:
 *   URLs carrying explicit types, via the object form of `ort.env.wasm.wasmPaths`
 *   ({ mjs, wasm } - the runtime reads r?.mjs and r?.wasm).
 *
 * Spec: 04 §3, 05b, 05b §2
 */

// Import ONLY the wasm backend. The bare 'onnxruntime-web' entry pulls in the
// WebGPU/JSEP build too, which added a 28 MB .wasm asset to the bundle - useless
// weight for a phone app that runs on the CPU/WASM backend.
import * as ort from 'onnxruntime-web/wasm';
import { CONFIG } from './config.js';

// no trailing slash: ORT joins this with the file name
const ASSET_BASE = new URL('models', document.baseURI).href;
const ORT_BASE = new URL('ort', document.baseURI).href;

const INPUT_SIZE = 160;
const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];

// single-threaded: no cross-origin isolation headers are set in dev or in the
// Capacitor WebView, and proxy mode would need them.
ort.env.wasm.numThreads = 1;

let ortStrategy = null;

async function blobUrlFor(url, mime) {
  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  if (!buf.byteLength) throw new Error(`${url} 为空文件`);
  return URL.createObjectURL(new Blob([buf], { type: mime }));
}

let wasmPathsReady = null;

/**
 * Point ORT at blob URLs we typed ourselves. Falls back to the plain path form,
 * which is what the dev server needs and which works wherever the asset loader
 * reports MIME types correctly.
 */
export function prepareWasmPaths() {
  if (!wasmPathsReady) {
    wasmPathsReady = (async () => {
      try {
        const [mjs, wasm] = await Promise.all([
          blobUrlFor(`${ORT_BASE}/ort-wasm-simd-threaded.mjs`, 'text/javascript'),
          blobUrlFor(`${ORT_BASE}/ort-wasm-simd-threaded.wasm`, 'application/wasm'),
        ]);
        ort.env.wasm.wasmPaths = { mjs, wasm };
        ortStrategy = 'blob';
      } catch (err) {
        console.warn('[FaceStroke] self-managed ORT assets unavailable, using the plain path', err);
        ort.env.wasm.wasmPaths = `${ORT_BASE}/`;
        ortStrategy = 'plain';
      }
    })();
  }
  return wasmPathsReady;
}

let meta = null;
let sessionQuality = null;
let sessionSymmetry = null;
let loadError = null;
const canvasCache = {};

function scratch(size) {
  if (!canvasCache[size]) {
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    canvasCache[size] = c;
  }
  return canvasCache[size];
}

/** Load the manifest once, then the two ONNX sessions lazily. */
export async function loadModels() {
  if (sessionQuality && sessionSymmetry) return true;
  if (loadError) return false;
  try {
    await prepareWasmPaths();
    if (!meta) {
      const res = await fetch(`${ASSET_BASE}/models.json`, { cache: 'force-cache' });
      meta = await res.json();
    }
    if (!sessionQuality) {
      sessionQuality = await ort.InferenceSession.create(`${ASSET_BASE}/${meta.quality.file}`, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
    }
    if (!sessionSymmetry) {
      sessionSymmetry = await ort.InferenceSession.create(`${ASSET_BASE}/${meta.symmetry.file}`, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
    }
    return true;
  } catch (err) {
    loadError = err;
    console.error('[FaceStroke] CNN models failed to load', err);
    return false;
  }
}

export function isReady() {
  return !!(sessionQuality && sessionSymmetry);
}

export function modelInfo() {
  return meta;
}

/**
 * Honest status for the screens: whether the channel is available, and if not,
 * why. Used so "AI 通道未参与" can say which of the reasons applies.
 */
export function modelStatus() {
  return {
    ready: !!((sessionQuality && sessionSymmetry)),
    error: loadError ? String(loadError.message || loadError) : null,
    strategy: ortStrategy,
  };
}

/** Forget a cached failure so a retry can actually work. */
export function resetModels() {
  sessionQuality = null;
  sessionSymmetry = null;
  loadError = null;
  meta = null;
  wasmPathsReady = null;
  ortStrategy = null;
}

/**
 * Why the optional AI channel did not take part.
 *
 * The device used to show a bare "AI 通道未参与本次评估", which gave the user no way
 * to tell a deliberate design choice from a broken model. It was broken; now the
 * screen says which of these applies.
 */
export const CNN_SKIP_TEXT = {
  ok: '',
  'load-failed': '（模型加载失败）',
  'load-timeout': '（模型加载超时）',
  budget: '（计算超出时间预算）',
  'no-score': '（本次未得出分数）',
};

/** Build a normalised NCHW float tensor from an image-like source. */
function toTensor(source) {
  const size = INPUT_SIZE;
  const c = scratch(size);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);
  const out = new Float32Array(3 * size * size);
  const plane = size * size;
  for (let i = 0; i < plane; i += 1) {
    const o = i * 4;
    out[i] = (data[o] / 255 - IMAGENET_MEAN[0]) / IMAGENET_STD[0];
    out[plane + i] = (data[o + 1] / 255 - IMAGENET_MEAN[1]) / IMAGENET_STD[1];
    out[2 * plane + i] = (data[o + 2] / 255 - IMAGENET_MEAN[2]) / IMAGENET_STD[2];
  }
  return new ort.Tensor('float32', out, [1, 3, size, size]);
}

function softmax(logits) {
  const m = Math.max(...logits);
  const ex = logits.map((v) => Math.exp(v - m));
  const s = ex.reduce((a, b) => a + b, 0);
  return ex.map((v) => v / s);
}

/**
 * Classify capture quality.
 * @returns {Promise<null|{label:string, confidence:number, probs:Record<string,number>}>}
 */
export async function predictQuality(source) {
  if (!(await loadModels())) return null;
  try {
    const feeds = { input: toTensor(source) };
    const out = await sessionQuality.run(feeds);
    const logits = Array.from(out[Object.keys(out)[0]].data);
    const probs = softmax(logits);
    const classes = meta.quality.classes;
    let best = 0;
    for (let i = 1; i < probs.length; i += 1) if (probs[i] > probs[best]) best = i;
    return {
      label: classes[best],
      confidence: probs[best],
      probs: Object.fromEntries(classes.map((c, i) => [c, probs[i]])),
    };
  } catch (err) {
    console.warn('[FaceStroke] M-Q inference failed', err);
    return null;
  }
}

/**
 * Predict the symmetry score (0-100) from one frame.
 * @returns {Promise<number|null>}
 */
export async function predictSymmetryScore(source) {
  if (!(await loadModels())) return null;
  try {
    const out = await sessionSymmetry.run({ input: toTensor(source) });
    const raw = Number(out[Object.keys(out)[0]].data[0]);
    const scale = Number(meta.symmetry.scale || 100);
    const score = raw <= 1.5 ? raw * scale : raw; // tolerate either 0-1 or 0-100 output
    return Math.round(Math.min(100, Math.max(0, score)) * 10) / 10;
  } catch (err) {
    console.warn('[FaceStroke] M-S inference failed', err);
    return null;
  }
}

/** Warm the sessions so the first real run is not the slow one. */
export async function warmUp() {
  const ok = await loadModels();
  return ok;
}

/** Whether the CNN channel should take part at all. */
export function cnnEnabled() {
  return !!CONFIG.fingerprints.cnn;
}
