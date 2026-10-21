/**
 * Capture quality gate - pure functions, no DOM, so they are unit-testable.
 *
 * Spec: 03 功能规格 S5 / 02 §5 防线二 / 06 §3.5
 *
 * RED LINE: an image that fails the gate must never produce a score. The gate is
 * not a nicety; it is the mechanism that keeps unusable frames out of the result.
 *
 * Thresholds live in core/config.js and are re-tuned with the bad-photo test set
 * built in task T-17.
 */

import { ANCHORS } from './symmetry.js';

export const REASON = {
  OK: 'ok',
  NO_FACE: 'no_face',
  MULTI_FACE: 'multi_face',
  TOO_DARK: 'too_dark',
  TOO_BRIGHT: 'too_bright',
  NOT_FRONTAL: 'not_frontal',
  TOO_FAR: 'too_far',
  OCCLUDED: 'occluded',
  BLURRY: 'blurry',
};

/**
 * User-facing instruction per reason.
 * Copy comes from 06_ui_and_copy.md §3.5. 2026-10-02: register moved from
 * colloquial to formal (user feedback).
 */
export const INSTRUCTION = {
  [REASON.OK]: '画面质量符合要求，请保持不动。',
  [REASON.NO_FACE]: '未检测到面部，请将面部置于取景框内。',
  [REASON.MULTI_FACE]: '画面中检测到多张人脸，请单人入镜。',
  [REASON.TOO_DARK]: '光线不足，请更换至明亮环境。',
  [REASON.TOO_BRIGHT]: '画面过曝，请避免背光或强光直射。',
  [REASON.NOT_FRONTAL]: '请正对摄像头，保持面部朝向镜头。',
  [REASON.TOO_FAR]: '请靠近一些，使面部充满取景框。',
  [REASON.OCCLUDED]: '检测到面部遮挡，请摘除口罩等遮挡物。',
  [REASON.BLURRY]: '图像模糊，请保持设备稳定后重试。',
};

/** Human-readable label for the four live indicator lamps. */
export const LAMP_LABEL = {
  light: '光线',
  frontal: '正脸',
  distance: '距离',
  clear: '清晰',
};

/* ------------------------------------------------------------------ pixels */

/**
 * Mean / percentile luminance of an RGBA buffer.
 * @param {Uint8ClampedArray} rgba
 * @returns {{mean:number,p5:number,p95:number}}
 */
export function luminanceStats(rgba) {
  const n = rgba.length / 4;
  const gray = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const o = i * 4;
    gray[i] = 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
  }
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += gray[i];
  const mean = sum / n;
  const sorted = Float32Array.from(gray).sort();
  const pct = (p) => sorted[Math.min(n - 1, Math.max(0, Math.floor((p / 100) * (n - 1))))];
  return { mean, p5: pct(5), p95: pct(95) };
}

/**
 * Variance of the Laplacian (a standard focus measure).
 * @param {Uint8ClampedArray} rgba
 * @param {number} w
 * @param {number} h
 */
export function laplacianVariance(rgba, w, h) {
  if (w < 3 || h < 3) return 0;
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i += 1) {
    const o = i * 4;
    gray[i] = 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
  }
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
      sum += lap;
      sumSq += lap * lap;
      count += 1;
    }
  }
  if (!count) return 0;
  const mean = sum / count;
  return sumSq / count - mean * mean;
}

/** Local focus inside one region of the frame (used for the occlusion heuristic). */
export function regionLaplacianVariance(rgba, w, h, x0, y0, x1, y1) {
  const cx0 = Math.max(0, Math.floor(x0));
  const cy0 = Math.max(0, Math.floor(y0));
  const cx1 = Math.min(w, Math.ceil(x1));
  const cy1 = Math.min(h, Math.ceil(y1));
  const rw = cx1 - cx0;
  const rh = cy1 - cy0;
  if (rw < 4 || rh < 4) return 0;
  const sub = new Uint8ClampedArray(rw * rh * 4);
  for (let y = 0; y < rh; y += 1) {
    const src = ((cy0 + y) * w + cx0) * 4;
    sub.set(rgba.subarray(src, src + rw * 4), y * rw * 4);
  }
  return laplacianVariance(sub, rw, rh);
}

/* --------------------------------------------------------------- landmarks */

/**
 * Yaw proxy in inter-ocular units: ~0 when the face is frontal.
 * Must match train/derive_mirror_pairs.py yaw_proxy().
 */
export function yawProxyOf(landmarks) {
  if (!landmarks || landmarks.length < 478) return Infinity;
  const n = landmarks[ANCHORS.nose_tip];
  const r = landmarks[ANCHORS.eye_r_outer];
  const l = landmarks[ANCHORS.eye_l_outer];
  const eyeDist = Math.hypot(l.x - r.x, l.y - r.y);
  if (!(eyeDist > 1e-6)) return Infinity;
  const dl = Math.hypot(n.x - r.x, n.y - r.y);
  const dr = Math.hypot(n.x - l.x, n.y - l.y);
  return Math.abs(dl - dr) / eyeDist;
}

/** Face width as a fraction of the frame width (MediaPipe coords are normalized). */
export function faceWidthRatioOf(landmarks) {
  if (!landmarks || landmarks.length < 468) return 0;
  let minX = Infinity;
  let maxX = -Infinity;
  for (let i = 0; i < 468; i += 1) {
    if (landmarks[i].x < minX) minX = landmarks[i].x;
    if (landmarks[i].x > maxX) maxX = landmarks[i].x;
  }
  return Math.max(0, maxX - minX);
}

/**
 * Occlusion heuristic.
 * A mask or a hand makes the lower face flat: its focus measure collapses
 * relative to the eye band. Returns the ratio lowerFocus / eyeFocus.
 */
export function mouthFlatnessRatio(landmarks, rgba, w, h) {
  if (!landmarks || landmarks.length < 478 || !rgba) return null;
  const box = (idx) => {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const i of idx) {
      const p = landmarks[i];
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    return [minX * w, minY * h, maxX * w, maxY * h];
  };
  // MediaPipe: 61/291 mouth corners, 13/14 lip centre, 33/263 eye outer corners
  const eyeBand = box([33, 263, 133, 362]);
  const mouthBox = box([61, 291, 13, 14]);
  const eyeFocus = regionLaplacianVariance(rgba, w, h, ...eyeBand);
  const mouthFocus = regionLaplacianVariance(rgba, w, h, ...mouthBox);
  if (!(eyeFocus > 1e-6)) return null;
  return mouthFocus / eyeFocus;
}

/* ------------------------------------------------------------------- gate */

/**
 * Decide whether a frame may be used.
 * @param {object} m metrics for one frame
 * @param {object} cfg thresholds
 * @returns {{passed:boolean, reasons:string[], lamps:object}}
 */
export function assessFrame(m, cfg) {
  const reasons = [];
  const lamps = { light: true, frontal: true, distance: true, clear: true };

  if (!m.faceFound) {
    reasons.push(REASON.NO_FACE);
    lamps.frontal = false;
    lamps.distance = false;
    return { passed: false, reasons, lamps };
  }
  if (m.faceCount > 1) {
    reasons.push(REASON.MULTI_FACE);
    lamps.frontal = false;
  }

  if (Number.isFinite(m.brightness)) {
    if (m.brightness < cfg.minBrightnessMean) {
      reasons.push(REASON.TOO_DARK);
      lamps.light = false;
    } else if (m.brightness > cfg.maxBrightnessMean) {
      reasons.push(REASON.TOO_BRIGHT);
      lamps.light = false;
    }
  }
  if (Number.isFinite(m.brightnessP95) && Number.isFinite(m.brightnessP5)) {
    // blown-out highlights also count as bad light
    if (m.brightnessP95 > 250 && m.brightnessP5 > 200) {
      if (!reasons.includes(REASON.TOO_BRIGHT)) reasons.push(REASON.TOO_BRIGHT);
      lamps.light = false;
    }
  }

  if (Number.isFinite(m.yawProxy) && m.yawProxy > cfg.maxYawProxy) {
    reasons.push(REASON.NOT_FRONTAL);
    lamps.frontal = false;
  }

  if (Number.isFinite(m.faceWidthRatio) && m.faceWidthRatio < cfg.minFaceWidthRatio) {
    reasons.push(REASON.TOO_FAR);
    lamps.distance = false;
  }

  if (Number.isFinite(m.sharpness) && m.sharpness < cfg.minSharpness) {
    reasons.push(REASON.BLURRY);
    lamps.clear = false;
  }

  if (m.mouthFlatness !== null && Number.isFinite(m.mouthFlatness)
      && m.mouthFlatness < cfg.minMouthFlatness) {
    reasons.push(REASON.OCCLUDED);
    lamps.clear = false;
  }

  return { passed: reasons.length === 0, reasons, lamps };
}

/** First instruction to show the user (most actionable reason wins). */
const PRIORITY = [
  REASON.NO_FACE, REASON.MULTI_FACE, REASON.TOO_DARK, REASON.TOO_BRIGHT,
  REASON.OCCLUDED, REASON.NOT_FRONTAL, REASON.TOO_FAR, REASON.BLURRY,
];

export function primaryInstruction(reasons) {
  if (!reasons || reasons.length === 0) return INSTRUCTION[REASON.OK];
  for (const r of PRIORITY) if (reasons.includes(r)) return INSTRUCTION[r];
  return INSTRUCTION[REASON.OK];
}

/* -------------------------------------------------------------- burst pick */

/**
 * Choose the best frames of a burst.
 * Score = sharpness (normalized) minus a yaw penalty. Ties keep capture order.
 * @param {Array<{sharpness:number,yawProxy:number}>} frames
 * @param {number} k how many to keep
 */
export function pickBestFrames(frames, k) {
  const scored = frames.map((f, i) => ({
    i,
    score: Number.isFinite(f.sharpness) ? f.sharpness : 0,
    yaw: Number.isFinite(f.yawProxy) ? f.yawProxy : 1,
  }));
  const maxSharp = Math.max(...scored.map((s) => s.score), 1e-9);
  scored.sort((a, b) => {
    const sa = a.score / maxSharp - a.yaw;
    const sb = b.score / maxSharp - b.yaw;
    if (sb !== sa) return sb - sa;
    return a.i - b.i;
  });
  return scored.slice(0, k).map((s) => s.i).sort((a, b) => a - b);
}

/**
 * Is the burst self-consistent? Used for the "capture unstable" rule.
 * @param {number[]} scores per-frame symmetry scores
 */
export function burstSpread(scores) {
  if (!scores || scores.length < 2) return 0;
  return Math.max(...scores) - Math.min(...scores);
}

export function isUnstable(spread, cfg) {
  if (!Number.isFinite(spread)) return true;
  if (cfg.maxFrameSpread === null || cfg.maxFrameSpread === undefined) return false;
  return spread > cfg.maxFrameSpread;
}
