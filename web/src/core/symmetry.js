/**
 * Geometric channel: measure left/right facial asymmetry.
 *
 * Spec: facestroke-build/05_model_training_plan.md section 6
 *
 * The mirror-pair table in mirror_pairs.json is NOT guessed: it was derived from
 * data by train/derive_mirror_pairs.py (reflect every template landmark across
 * the canonical midline, keep mutual nearest neighbours). 220 pairs survived
 * with a median mirror residual of 0.0059 in inter-ocular units.
 *
 * Pipeline
 *   landmarks -> canonical frame -> midline -> per-pair distance difference
 *             -> per-zone mean -> overall asymmetry A -> 0-100 score
 *
 * RED LINE: never produce a score when the landmark set is missing or degenerate.
 */

import pairsData from './mirror_pairs.js';

export const ANCHORS = pairsData.anchors;
/** [nasion, chin] - the two points that define the facial midline. */
export const AXIS = pairsData.axis;
/** All mirror pairs as [i, j]. */
export const PAIRS = pairsData.pairs_flat;
/** zone name -> [[i, j], ...] */
export const ZONES = pairsData.pairs;
/** Clinical observation zones, in reporting order. */
export const ZONE_NAMES = ['forehead', 'eyelid', 'nasolabial', 'mouth'];
export const ZONE_LABELS = {
  forehead: '额纹区',
  eyelid: '眼睑区',
  nasolabial: '鼻唇沟区',
  mouth: '口角区',
  other: '其他区域',
};

/** Data-derived calibration anchors (see work/reports/symmetry_calibration.md). */
export const CALIBRATION = pairsData.zone_stats?._overall
  ? { aRef: pairsData.zone_stats._overall.p50, aMax: pairsData.zone_stats._overall.p99 }
  : { aRef: 0.0275, aMax: 0.1244 };

/**
 * Map raw normalized landmarks into the canonical frame.
 *
 * FRAME DEFINITION
 *   origin = eye midpoint
 *   scale  = inter-ocular distance
 *   rotation = the MIDLINE (nasion -> chin) is made vertical
 *
 * WHY THE MIDLINE AND NOT THE EYE LINE
 *   The reference axis should not be built from the thing being measured. A
 *   unilateral facial droop displaces an eye corner, so anchoring rotation on
 *   the eye line puts part of the measured signal into the reference frame.
 *   Nasion and chin sit on the midline and are not displaced by a one-sided
 *   droop, so they make a more stable reference.
 *
 *   (An earlier code comment here claimed eye-line alignment was "blind to
 *   droop". That was wrong - it was a symptom of the mirror bug below. With a
 *   correct mirror both alignments respond linearly; midline is kept as the
 *   more conservative reference.)
 *
 * @returns {Array<{x:number,y:number}>|null} null when the face is degenerate
 */
export function align(landmarks) {
  if (!landmarks || landmarks.length < 478) return null;
  const r = landmarks[ANCHORS.eye_r_outer];
  const l = landmarks[ANCHORS.eye_l_outer];
  const scale = Math.hypot(l.x - r.x, l.y - r.y);
  if (!Number.isFinite(scale) || scale < 1e-6) return null;

  const a = landmarks[AXIS[0]];
  const b = landmarks[AXIS[1]];
  const vlen = Math.hypot(b.x - a.x, b.y - a.y);
  if (!Number.isFinite(vlen) || vlen < 1e-9) return null;
  const vx = (b.x - a.x) / vlen;
  const vy = (b.y - a.y) / vlen;

  // R maps the midline direction onto (0, 1): x' = vy*x - vx*y, y' = vx*x + vy*y
  const midX = (r.x + l.x) / 2;
  const midY = (r.y + l.y) / 2;

  return landmarks.map((p) => {
    const x = (p.x - midX) / scale;
    const y = (p.y - midY) / scale;
    return { x: vy * x - vx * y, y: vx * x + vy * y };
  });
}

/**
 * Reflect a canonical-frame point across the LINE through (a, b).
 *
 * BUG HISTORY: the first version used `2*(a + t*n) - p` with t measured along
 * the normal. That is a POINT reflection, not a line reflection, and with a
 * vertical midline it left x unchanged and flipped y - i.e. the whole geometric
 * channel measured nonsense. The correct formula subtracts twice the normal
 * component: p - 2*t*n.
 */
export function mirrorAcross(p, a, b) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const n = Math.hypot(abx, aby);
  if (!Number.isFinite(n) || n < 1e-9) return { x: NaN, y: NaN };
  const nx = -aby / n;
  const ny = abx / n;
  const t = (p.x - a.x) * nx + (p.y - a.y) * ny; // signed distance to the line
  return { x: p.x - 2 * t * nx, y: p.y - 2 * t * ny };
}

/**
 * Asymmetry per zone, as the mean mirror error of the mirror pairs.
 *
 * HISTORY / WHY NOT "distance to the midline":
 * v1 used |dist(p_i, midline) - dist(p_j, midline)|. A unit test showed that is
 * BLIND TO VERTICAL DROOP -- with a vertical midline the perpendicular distance
 * is just |x|, so lowering a mouth corner changes nothing, yet vertical sag is
 * the dominant clinical sign of facial droop.
 *
 * v2 compares the mirrored face to the real face:  d(i,j) = || mirror(p_i) - p_j ||
 * which captures horizontal AND vertical mismatch.
 *
 * @returns {{zones: Record<string, number>, pairs: Array<{i:number,j:number,diff:number}>}|null}
 */
export function zoneAsymmetry(landmarks) {
  const aligned = align(landmarks);
  if (!aligned) return null;
  const a = aligned[AXIS[0]];
  const b = aligned[AXIS[1]];
  if (!a || !b) return null;

  const mirrored = aligned.map((p) => mirrorAcross(p, a, b));

  const buckets = {};
  const pairDiffs = [];
  for (const zone of Object.keys(ZONES)) {
    const list = ZONES[zone];
    if (!list.length) continue;
    let sum = 0;
    for (const [i, j] of list) {
      const d = Math.hypot(mirrored[i].x - aligned[j].x, mirrored[i].y - aligned[j].y);
      sum += d;
      if (zone !== 'other') pairDiffs.push({ i, j, diff: d });
    }
    buckets[zone] = sum / list.length;
  }
  return { zones: buckets, pairs: pairDiffs };
}

/**
 * Overall asymmetry A from per-zone values using the configured weights.
 * Weights default to equal; the doctor's sign-off is tracked as 🔴-04.
 */
export function overallAsymmetry(zones, zoneWeights) {
  let num = 0;
  let den = 0;
  for (const z of ZONE_NAMES) {
    if (zones[z] === undefined) continue;
    const w = Number(zoneWeights?.[z] ?? 1);
    num += zones[z] * w;
    den += w;
  }
  return den > 0 ? num / den : null;
}

/**
 * Map asymmetry to a 0-100 "symmetry score" (100 = symmetrical).
 * S = 100 * (1 - clip((A - aRef) / (aMax - aRef), 0, 1))
 */
export function scoreFromAsymmetry(a, aRef, aMax) {
  if (a === null || !Number.isFinite(a)) return null;
  if (!Number.isFinite(aRef) || !Number.isFinite(aMax) || aMax <= aRef) return null;
  const t = (a - aRef) / (aMax - aRef);
  const clipped = Math.min(1, Math.max(0, t));
  return Math.round((1 - clipped) * 1000) / 10; // 0-100, one decimal
}

/**
 * Full geometric channel for one frame.
 * @returns {null|{score:number, zones:Record<string,number>, a:number, pairs:Array}}
 */
export function computeGeometry(landmarks, opts = {}) {
  const { aRef = CALIBRATION.aRef, aMax = CALIBRATION.aMax, zoneWeights = null } = opts;
  const res = zoneAsymmetry(landmarks);
  if (!res) return null;
  const a = overallAsymmetry(res.zones, zoneWeights);
  const score = scoreFromAsymmetry(a, aRef, aMax);
  if (score === null) return null;
  return { score, zones: res.zones, a, pairs: res.pairs };
}

/**
 * Aggregate several frames of the same capture.
 * Uses the median score (robust to one bad frame) and reports the spread so the
 * caller can apply the stability rule (03 功能规格 S5).
 */
export function aggregateFrames(results) {
  const ok = results.filter(Boolean);
  if (!ok.length) return null;
  const scores = ok.map((r) => r.score).sort((x, y) => x - y);
  const mid = Math.floor(scores.length / 2);
  const median = scores.length % 2 ? scores[mid] : (scores[mid - 1] + scores[mid]) / 2;
  const zones = {};
  for (const z of ZONE_NAMES) {
    const vals = ok.map((r) => r.zones[z]).filter((v) => v !== undefined).sort((x, y) => x - y);
    if (vals.length) zones[z] = vals[Math.floor(vals.length / 2)];
  }
  return {
    score: median,
    zones,
    spread: scores[scores.length - 1] - scores[0],
    nFrames: ok.length,
  };
}
