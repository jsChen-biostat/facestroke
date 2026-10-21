/**
 * Trend summarising for the records screen - pure functions, unit-testable.
 * Spec: 03 功能规格 S10
 *
 * The product talks about the CHANGE versus your own history, because an
 * absolute score means little on its own (see the plan, 05 §6 and 04 §2).
 */

/** Points needed before a trend is meaningful. */
export const MIN_POINTS = 2;
/** Score change below this counts as "about the same". */
export const STABLE_BAND = 3;
/** Spread across the window above this counts as volatile. */
export const VOLATILE_SPREAD = 15;

export const TREND_PHRASE = {
  insufficient: '记录还太少，先攒几次再看变化。',
  stable: '近期比较稳定。',
  improving: '近期有缓慢改善。',
  worsening: '近期有缓慢下降，可以多留意。',
  volatile: '近期波动较大，建议以线下检查为准。',
};

/**
 * @param {Array<{timestamp:string, score:number}>} records oldest first
 * @returns {{n:number, latest:number|null, previous:number|null, delta:number|null,
 *            direction:string, spread:number, phrase:string}}
 */
export function summarizeTrend(records) {
  const list = (records || [])
    .filter((r) => r && Number.isFinite(r.score))
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));

  const n = list.length;
  if (n === 0) {
    return { n, latest: null, previous: null, delta: null, direction: 'insufficient', spread: 0, phrase: TREND_PHRASE.insufficient };
  }

  const scores = list.map((r) => r.score);
  const latest = scores[scores.length - 1];
  const previous = n >= 2 ? scores[scores.length - 2] : null;
  const delta = previous === null ? null : Math.round((latest - previous) * 10) / 10;
  const spread = Math.round((Math.max(...scores) - Math.min(...scores)) * 10) / 10;

  let direction = 'insufficient';
  if (n >= MIN_POINTS) {
    if (spread > VOLATILE_SPREAD) direction = 'volatile';
    else if (delta === null || Math.abs(delta) < STABLE_BAND) direction = 'stable';
    else direction = delta > 0 ? 'improving' : 'worsening';
  }

  return { n, latest, previous, delta, direction, spread, phrase: TREND_PHRASE[direction] };
}

/**
 * Map records onto chart coordinates.
 * @param {Array} records oldest first
 * @param {{width:number,height:number,padding:number,minScore?:number,maxScore?:number}} opts
 * @returns {{points:Array<{x:number,y:number,score:number,timestamp:string}>,
 *            xLabels:Array<{x:number,text:string}>, yTicks:Array<{y:number,text:string}>}}
 */
export function chartPoints(records, opts) {
  const { width, height, padding } = opts;
  const list = (records || []).filter((r) => r && Number.isFinite(r.score));
  const minScore = Number.isFinite(opts.minScore) ? opts.minScore : 0;
  const maxScore = Number.isFinite(opts.maxScore) ? opts.maxScore : 100;

  const innerW = Math.max(1, width - padding * 2);
  const innerH = Math.max(1, height - padding * 2);
  const xAt = (i) => (list.length <= 1 ? padding + innerW / 2 : padding + (i / (list.length - 1)) * innerW);
  const yAt = (s) => padding + innerH - ((s - minScore) / Math.max(1e-9, maxScore - minScore)) * innerH;

  const points = list.map((r, i) => ({
    x: xAt(i),
    y: yAt(r.score),
    score: r.score,
    timestamp: r.timestamp,
  }));

  const labelEvery = Math.max(1, Math.ceil(list.length / 4));
  const xLabels = list
    .map((r, i) => ({ x: xAt(i), text: String(r.timestamp || '').slice(5, 10) }))
    .filter((_, i) => i % labelEvery === 0 || i === list.length - 1);

  const yTicks = [minScore, (minScore + maxScore) / 2, maxScore].map((v) => ({
    y: yAt(v),
    text: String(Math.round(v)),
  }));

  return { points, xLabels, yTicks };
}

/** Format a record row for the list. */
export function recordRow(rec) {
  const d = String(rec.timestamp || '').slice(0, 10);
  const tier = rec.tier ? rec.tier : '—';
  return { date: d, score: rec.score, tier };
}
