/**
 * Thin wrapper around MediaPipe FaceLandmarker.
 *
 * Rules (04_technical_architecture.md section 7):
 *  - assets are served from our own origin, never a CDN, so the app works offline
 *  - the landmark model is loaded once and reused
 *  - this module never touches the network after the initial asset load
 *
 * 2026-10-02 fifth revision - WHY THE ASSETS ARE FETCHED BY HAND.
 *
 * On the device the model never loaded while the identical code worked in a
 * desktop browser. Two things differ inside a Capacitor WebView, and both break
 * MediaPipe's own asset loading:
 *
 *   1. PATH. `FilesetResolver.forVisionTasks(base)` builds `${base}/name.js`. We
 *      passed a base that already ended in "/", so the real URL contained "//".
 *      A normal HTTP server normalises that away; Android's WebViewAssetLoader
 *      hands the raw path to AssetManager.open(), which does not.
 *   2. MIME. The asset loader guesses Content-Type from the file extension and
 *      returns null when it does not know it. MediaPipe injects the loader as a
 *      <script src>, and a script served with the wrong Content-Type is refused
 *      by Chromium. The .wasm has the same problem for instantiateStreaming.
 *
 * So we fetch the bytes ourselves with `fetch()` (which goes through exactly the
 * same asset loader) and hand MediaPipe blob: URLs carrying an explicit, correct
 * Content-Type. The plain path-based fileset stays as a fallback for the dev
 * server and for any environment where the blob route is unavailable.
 */

import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

// no trailing slash: MediaPipe appends "/name.js" to this
const ASSET_BASE = new URL('mediapipe', document.baseURI).href;

export const N_LANDMARKS = 478;

let landmarkerPromise = null;
let assetStrategy = null;

/** Fetch one model asset and return it as a blob: URL with a known MIME type. */
async function blobUrlFor(name, mime) {
  const url = `${ASSET_BASE}/${name}`;
  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`${name} HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  if (!buf.byteLength) throw new Error(`${name} 为空文件`);
  return URL.createObjectURL(new Blob([buf], { type: mime }));
}

let filesetPromise = null;

/**
 * Build the wasm fileset, preferring self-managed blob URLs.
 * @returns {Promise<{wasmLoaderPath:string, wasmBinaryPath:string, strategy:string}>}
 */
function getFileset() {
  if (!filesetPromise) {
    filesetPromise = (async () => {
      try {
        const simd = await FilesetResolver.isSimdSupported();
        const stem = simd ? 'vision_wasm_internal' : 'vision_wasm_nosimd_internal';
        const [loader, wasm] = await Promise.all([
          blobUrlFor(`${stem}.js`, 'text/javascript'),
          blobUrlFor(`${stem}.wasm`, 'application/wasm'),
        ]);
        assetStrategy = 'blob';
        return { wasmLoaderPath: loader, wasmBinaryPath: wasm, strategy: 'blob' };
      } catch (err) {
        console.warn('[FaceStroke] self-managed wasm assets unavailable, using the plain path', err);
        const fileset = await FilesetResolver.forVisionTasks(ASSET_BASE);
        assetStrategy = 'plain';
        return { ...fileset, strategy: 'plain' };
      }
    })();
  }
  return filesetPromise;
}

let taskUrlPromise = null;

/** The .task model bundle, also via a blob URL so its MIME is never guessed. */
function getModelAssetPath() {
  if (!taskUrlPromise) {
    taskUrlPromise = blobUrlFor('face_landmarker.task', 'application/octet-stream')
      .catch((err) => {
        console.warn('[FaceStroke] model bundle blob failed, using the plain path', err);
        return `${ASSET_BASE}/face_landmarker.task`;
      });
  }
  return taskUrlPromise;
}

/** Diagnostics for the long-press panel. */
export function assetInfo() {
  return { base: ASSET_BASE, strategy: assetStrategy };
}

async function createLandmarker(runningMode, numFaces) {
  const [fileset, modelAssetPath] = await Promise.all([getFileset(), getModelAssetPath()]);
  return FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath, delegate: 'CPU' },
    runningMode,
    numFaces,
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: false,
  });
}

/** @returns {Promise<FaceLandmarker>} */
export function getLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = createLandmarker('IMAGE', 1);
  }
  return landmarkerPromise;
}

/**
 * Detect landmarks in one image.
 * @param {HTMLImageElement|HTMLCanvasElement|ImageBitmap} source
 * @returns {Promise<Array<{x:number,y:number,z:number}>|null>} null when no face found
 */
export async function detectLandmarks(source) {
  const landmarker = await getLandmarker();
  const result = landmarker.detect(source);
  const faces = result?.faceLandmarks;
  if (!faces || faces.length === 0) return null;
  const pts = faces[0];
  if (pts.length < 468) return null;
  return pts.map((p) => ({ x: p.x, y: p.y, z: p.z ?? 0 }));
}

/** Warm up the model so the first real detection is not the slow one. */
export async function warmUp() {
  try {
    await getLandmarker();
    return true;
  } catch (err) {
    console.error('[FaceStroke] landmark model failed to load', err);
    return false;
  }
}

/**
 * Forget the cached model promises.
 *
 * Without this a failed load is cached as a REJECTED promise for the whole
 * session, so a "reload the model" button could never succeed - retrying just
 * returned the same rejection. Reported from the third device test as "the
 * button does nothing".
 */
export function resetModels() {
  landmarkerPromise = null;
  livePromise = null;
  filesetPromise = null;
  taskUrlPromise = null;
  assetStrategy = null;
}

/** Reject after `ms` so a hung model load cannot block the screen forever. */
function withTimeout(promise, ms, tag) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${tag}-timeout`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

/* ------------------------------------------------------------------- live */

let livePromise = null;

/**
 * A second FaceLandmarker instance in VIDEO mode, used for the live capture
 * screen (real-time quality lamps). Kept separate from the IMAGE-mode instance
 * because MediaPipe will not switch running modes on an existing instance.
 */
export function getLiveLandmarker() {
  if (!livePromise) {
    livePromise = createLandmarker('VIDEO', 2); // >1 so we can tell the user "one face at a time"
  }
  return livePromise;
}

/**
 * Detect on a video frame.
 * @param {HTMLVideoElement} video
 * @param {number} timestampMs monotonically increasing
 * @returns {Promise<{faces: Array<Array<{x:number,y:number,z:number}>>}>}
 */
export async function detectForVideo(video, timestampMs) {
  const landmarker = await getLiveLandmarker();
  const res = landmarker.detectForVideo(video, timestampMs);
  const faces = (res?.faceLandmarks || []).map((pts) => pts.map((p) => ({ x: p.x, y: p.y, z: p.z ?? 0 })));
  return { faces };
}

/**
 * Readable text for whatever a model load threw.
 *
 * MediaPipe reports a failed <script src> as a bare Event, which printed as
 * "[object Event]" and told us nothing. Pull the URL out when there is one.
 */
function describeError(err) {
  if (!err) return '未知错误';
  if (typeof err === 'string') return err;
  if (err.message) return String(err.message);
  if (typeof Event !== 'undefined' && err instanceof Event) {
    const src = err.target?.src || err.target?.currentSrc;
    return `${err.type || 'event'}${src ? ` @ ${src}` : ''}`;
  }
  return String(err);
}

/**
 * Fetch every asset the model needs and report exactly which one is unusable.
 * Turns "the model did not load" into "vision_wasm_internal.wasm HTTP 404".
 * @returns {Promise<{ok:boolean, entries:Array<{name:string,status:number|string,bytes:number,type:string}>}>}
 */
export async function preflight() {
  let stem = 'vision_wasm_internal';
  try {
    if (!(await FilesetResolver.isSimdSupported())) stem = 'vision_wasm_nosimd_internal';
  } catch { /* keep the SIMD name */ }
  const names = [`${stem}.js`, `${stem}.wasm`, 'face_landmarker.task'];
  const entries = [];
  let ok = true;
  for (const name of names) {
    try {
      const res = await fetch(`${ASSET_BASE}/${name}`, { cache: 'force-cache' });
      const buf = await res.arrayBuffer();
      if (!res.ok || !buf.byteLength) ok = false;
      entries.push({
        name, status: res.status, bytes: buf.byteLength, type: res.headers.get('content-type') || '',
      });
    } catch (err) {
      ok = false;
      entries.push({ name, status: describeError(err), bytes: 0, type: '' });
    }
  }
  return { ok, entries };
}

/**
 * Load both models and report the outcome instead of throwing.
 * Used by the capture screen so a model failure becomes a visible, actionable
 * message rather than a silent "no face detected".
 * @param {{timeoutMs?:number}} [opts] never wait longer than this for the models
 * @returns {Promise<{ok:boolean, image:boolean, video:boolean, error:string|null, detail:string, strategy:string|null, files:Array|null}>}
 */
export async function warmUpStatus({ timeoutMs = 0 } = {}) {
  const out = {
    ok: false, image: false, video: false, error: null, detail: '', strategy: null, files: null,
  };
  const guard = (p, tag) => (timeoutMs > 0 ? withTimeout(p, timeoutMs, tag) : p);
  try {
    await guard(getLandmarker(), 'image-model');
    out.image = true;
  } catch (err) {
    out.error = 'image-model';
    out.detail = describeError(err);
    out.strategy = assetStrategy;
    try { out.files = (await preflight()).entries; } catch { /* diagnostics only */ }
    return out;
  }
  try {
    await guard(getLiveLandmarker(), 'video-model');
    out.video = true;
  } catch (err) {
    out.error = 'video-model';
    out.detail = describeError(err);
    out.strategy = assetStrategy;
    try { out.files = (await preflight()).entries; } catch { /* diagnostics only */ }
    return out;
  }
  out.ok = true;
  out.strategy = assetStrategy;
  return out;
}

/* ------------------------------------------------- rotation-robust detect */

/** Rotate a NORMALISED point back to the original frame orientation. */
export function rotatePointBack(p, angle) {
  switch (angle) {
    case 90: return { x: p.y, y: 1 - p.x, z: p.z };
    case 180: return { x: 1 - p.x, y: 1 - p.y, z: p.z };
    case 270: return { x: 1 - p.y, y: p.x, z: p.z };
    default: return p;
  }
}

function rotatedCanvas(src, angle, maxSide = 640) {
  const sw = src.width || src.videoWidth || 0;
  const sh = src.height || src.videoHeight || 0;
  if (!sw || !sh) return null;
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.round(sw * scale);
  const h = Math.round(sh * scale);
  const c = document.createElement('canvas');
  if (angle === 90 || angle === 270) {
    c.width = h;
    c.height = w;
  } else {
    c.width = w;
    c.height = h;
  }
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((angle * Math.PI) / 180);
  ctx.drawImage(src, -w / 2, -h / 2, w, h);
  return c;
}

/**
 * Detect landmarks, retrying with the frame rotated.
 *
 * A phone photo can be stored "lying down" (EXIF orientation) and some Android
 * front cameras deliver a rotated stream. In both cases the face is sideways in
 * the pixels, MediaPipe returns nothing, and the user sees a meaningless
 * "no face detected". Retrying at 90/180/270 recovers those frames; the returned
 * landmarks are transformed back into the original frame orientation so the
 * symmetry maths stays upright.
 *
 * @param {HTMLImageElement|HTMLCanvasElement|ImageBitmap} source
 * @returns {Promise<{landmarks:Array|null, rotation:number, modelError:boolean}>}
 */
export async function detectLandmarksRobust(source) {
  // A model that never loaded is NOT "no face in this photo". Check first and say
  // so, otherwise a broken model hides behind a plausible-looking message.
  try {
    await getLandmarker();
  } catch (err) {
    console.error('[FaceStroke] landmark model unavailable', err);
    return { landmarks: null, rotation: 0, modelError: true };
  }
  try {
    const direct = await detectLandmarks(source);
    if (direct) return { landmarks: direct, rotation: 0, modelError: false };
  } catch (err) {
    console.warn('[FaceStroke] direct detection failed', err);
  }
  for (const angle of [90, 270, 180]) {
    try {
      const canvas = rotatedCanvas(source, angle);
      if (!canvas) return { landmarks: null, rotation: 0, modelError: false };
      // eslint-disable-next-line no-await-in-loop
      const found = await detectLandmarks(canvas);
      if (found) {
        return {
          landmarks: found.map((p) => rotatePointBack(p, angle)),
          rotation: angle,
          modelError: false,
        };
      }
    } catch (err) {
      console.warn(`[FaceStroke] detection at ${angle}° failed`, err);
    }
  }
  return { landmarks: null, rotation: 0, modelError: false };
}

/** Decode a Blob into a bitmap, honouring EXIF orientation where supported. */
export async function blobToBitmap(blob) {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch (err) {
    console.warn('[FaceStroke] EXIF-aware decode unavailable, using default', err);
    return createImageBitmap(blob);
  }
}
