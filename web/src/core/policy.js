/**
 * Small product policies that must be testable in isolation.
 * Spec: 02 §5 特殊场景处理 / 03 功能规格 S7 防刷分
 *
 * Two of these were real gaps found while writing the T-17 regression suite:
 *  - the palsy marker was stored in settings but never consulted, so a person
 *    with known facial palsy would still be pushed into the urgent tier
 *  - the same-day repeat rule existed in the spec but was not implemented
 */

import { ACTION_LABELS } from './report.js';

/** The tier an action-test finding can pull a result down to. */
export const ACTION_TIER_CAP = 'B';

/** Tiers, ordered from least to most severe. */
export const TIER_ORDER = ['A', 'B', 'C', 'D'];

/**
 * Extra evidence may only ever make the app MORE cautious, never more reassuring.
 *
 * The guided action test can show a marked asymmetry that a single static frame
 * missed (a mild facial palsy often appears only on movement). When that happens
 * the tier is capped at B - "建议观察" - even if the static image looked clean.
 *
 * The reverse never happens: a clean action test cannot lift a tier that the
 * static measurement put lower. That asymmetry is the whole point of the rule,
 * and it is why this can be shipped while the action thresholds are still
 * provisional.
 *
 * @param {'A'|'B'|'C'|'D'|null} tier
 * @param {{skipped:boolean, items:Array<{key:string, notable:boolean}>}|null} actionTest
 * @param {boolean} palsy the user declared known facial palsy / recent change
 * @returns {{tier: string|null, capped: boolean, note: string|null}}
 */
export function applyActionTest(tier, actionTest, palsy = false) {
  if (!tier || !actionTest || actionTest.skipped) return { tier: tier ?? null, capped: false, note: null };
  const notable = (actionTest.items || []).filter((it) => it && it.notable);
  if (!notable.length) return { tier, capped: false, note: null };
  // a declared palsy means the baseline is already asymmetric on purpose
  if (palsy) return { tier, capped: false, note: null };

  const current = TIER_ORDER.indexOf(tier);
  const cap = TIER_ORDER.indexOf(ACTION_TIER_CAP);
  // TIER_ORDER runs least -> most severe, so a LOWER index is the more
  // reassuring answer. Only pull a more reassuring tier down to the cap.
  if (current < 0 || current >= cap) return { tier, capped: false, note: null };

  const names = notable.map((it) => ACTION_LABELS[it.key] || it.key).join('、');
  return {
    tier: ACTION_TIER_CAP,
    capped: true,
    note: `在做「${names}」动作时，两侧不对称度超出参考范围，本次结论按「建议观察」呈现。`,
  };
}

/**
 * Cap the tier for a user who has declared facial palsy / recent facial change.
 *
 * Rationale (02 §5): someone whose baseline is already asymmetric should not be
 * told "urgent" every single time. We still report the measurement, but the
 * alarm tier is withheld and the app says why.
 *
 * @param {'A'|'B'|'C'|'D'|null} tier
 * @param {boolean} palsy
 * @returns {{tier: string|null, capped: boolean, note: string|null}}
 */
export function applyPalsyOverride(tier, palsy) {
  if (!palsy || !tier) return { tier: tier ?? null, capped: false, note: null };
  if (tier === 'D') {
    return {
      tier: 'C',
      capped: true,
      note: '你已标记有面瘫或近期面部变化，本次不按「紧急」提示，请结合自己的情况判断。',
    };
  }
  return { tier, capped: false, note: null };
}

/** Local date string (YYYY-MM-DD) for a Date or ISO timestamp. */
export function localDateOf(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * How many records already exist for the same local day.
 * @param {Array<{timestamp:string}>} records
 * @param {Date} [now]
 */
export function sameDayCount(records, now = new Date()) {
  const today = localDateOf(now);
  return (records || []).filter((r) => r && localDateOf(r.timestamp) === today).length;
}

/**
 * The anti-refresh rule (03 功能规格 S7): repeating a test must not look like it
 * changes the underlying situation.
 *
 * @param {number} count how many records exist for today, INCLUDING this one
 * @returns {string|null} note to show, or null when nothing should be said
 */
export function antiRefreshNote(count) {
  if (!Number.isFinite(count) || count <= 1) return null;
  return `今天这是第 ${count} 次检测。重复检测不会改变真实情况，建议按提示定期复测。`;
}

/**
 * Expected total detection duration in seconds, from the pacing config.
 * Used by the G3 regression check (20-30 s target) so the number is asserted
 * rather than eyeballed.
 */
export function expectedDurationSeconds(pacing, capture) {
  const analysis = ((pacing?.analysisMinMs ?? 8000) + (pacing?.analysisMaxMs ?? 12000)) / 2 / 1000;
  const countdown = capture?.countdownSeconds ?? 3;
  const burst = ((capture?.framesToCapture ?? 10) * 100) / 1000;
  const guidance = 6; // time to read the prep screen and steady the phone
  return { analysis, capture: countdown + burst + guidance, total: analysis + countdown + burst + guidance };
}
