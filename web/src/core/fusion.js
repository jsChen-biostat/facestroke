/**
 * Two-channel fusion.
 * Spec: 05b_CNN任务修订 §5 / 05 §8
 *
 *   S_final = w_geo * S_geo + w_cnn * S_cnn
 *
 * The CNN channel can be absent (model not loaded, or no face detected by the
 * pixel model) - in that case we fall back to the geometric score alone and say
 * so, rather than inventing a value.
 *
 * When the two channels disagree by more than `fusionConflictGap` we refuse to
 * pick a tier: an inconsistent reading is itself information, and forcing it
 * would be the opposite of the "quality gate" philosophy used elsewhere.
 */

export const FUSION_VERSION = 'fusion-1.0';

/**
 * @param {number|null} geoScore 0-100, geometric channel
 * @param {number|null} cnnScore 0-100, CNN channel (may be null)
 * @param {{geo:number, cnn:number, role?:string, approved?:boolean}} weights
 * @param {number} conflictGap
 * @returns {{score:number|null, cnnUsed:boolean, cnnRole:string, conflict:boolean,
 *            gap:number|null, geo:number|null, cnn:number|null, weights:object}}
 */
export function fuse(geoScore, cnnScore, weights, conflictGap) {
  const role = weights?.role || 'scored';
  const base = {
    geo: geoScore ?? null,
    cnn: cnnScore ?? null,
    cnnUsed: false,
    cnnRole: role,
    conflict: false,
    gap: null,
    weights: weights || null,
  };

  if (!Number.isFinite(geoScore)) return { ...base, score: null };
  if (!Number.isFinite(cnnScore)) return { ...base, score: geoScore };

  const gap = Math.abs(geoScore - cnnScore);
  const conflict = Number.isFinite(conflictGap) && gap > conflictGap;

  // CROSS-CHECK MODE
  // 05b §5 downgrade rule: the trained M-S reached test MAE 19.3 points and
  // Spearman 0.52, and it is WORST in the low-score range that matters most
  // (MAE 32.8 in the 0-20 bin). It is therefore not allowed to move the score.
  // It still runs, and a large disagreement between the two channels is
  // surfaced as "the two readings differ" instead of being averaged away.
  if (role === 'cross-check') {
    return { ...base, cnnUsed: true, conflict, gap, score: geoScore };
  }

  const wGeo = Number(weights?.geo);
  const wCnn = Number(weights?.cnn);
  if (!Number.isFinite(wGeo) || !Number.isFinite(wCnn) || wGeo + wCnn <= 0) {
    return { ...base, score: geoScore };
  }

  const score = (wGeo * geoScore + wCnn * cnnScore) / (wGeo + wCnn);
  return {
    ...base,
    cnnUsed: true,
    conflict,
    gap,
    score: Math.round(score * 10) / 10,
  };
}

/** Median of a numeric list, ignoring nulls/NaN. */
export function median(values) {
  const v = (values || []).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** True when the CNN channel is confident enough to veto an obviously bad frame. */
export function cnnHardReject(qualityResult, cfg) {
  if (!qualityResult) return false;
  const limit = Number(cfg?.cnnRejectConfidence ?? 0.85);
  const hardBad = new Set(['too_dark', 'too_bright', 'blurry', 'occluded', 'turned']);
  return hardBad.has(qualityResult.label) && qualityResult.confidence >= limit;
}
