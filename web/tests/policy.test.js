/**
 * Unit tests for the product policies (web/src/core/policy.js).
 * Spec: 02 §5 特殊场景处理 / 03 功能规格 S7 防刷分 / S6 时长
 *
 * These cover two rules that were specified but NOT implemented until the T-17
 * regression pass - the palsy override and the anti-refresh note.
 *
 * Run: cd web && npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyPalsyOverride, applyActionTest, ACTION_TIER_CAP,
  localDateOf, sameDayCount, antiRefreshNote,
  expectedDurationSeconds, TIER_ORDER,
} from '../src/core/policy.js';

/* ------------------------------------------------------ action test cap */

const notableTest = (key) => ({ skipped: false, items: [{ key, notable: true }] });
const quietTest = () => ({ skipped: false, items: [{ key: 'smile', notable: false }] });

test('a notable action finding pulls a clean result down to 建议观察', () => {
  const r = applyActionTest('A', notableTest('smile'));
  assert.equal(r.tier, ACTION_TIER_CAP);
  assert.equal(r.capped, true);
  assert.match(r.note, /露齿微笑/, 'the note must name the action');
});

test('extra evidence can never make a result MORE reassuring', () => {
  // the asymmetry of this rule is the whole point: a clean action test must not
  // lift a tier the static measurement put lower
  assert.equal(applyActionTest('C', quietTest()).tier, 'C');
  assert.equal(applyActionTest('D', quietTest()).tier, 'D');
  assert.equal(applyActionTest('C', notableTest('brow')).tier, 'C', 'already more cautious');
  assert.equal(applyActionTest('D', notableTest('brow')).tier, 'D', 'never softened');
});

test('a skipped or failed action test changes nothing', () => {
  for (const at of [null, undefined, { skipped: true }, { skipped: true, items: [{ notable: true }] }]) {
    const r = applyActionTest('A', at);
    assert.equal(r.tier, 'A');
    assert.equal(r.capped, false);
  }
});

test('a declared palsy baseline suppresses the action cap', () => {
  const r = applyActionTest('A', notableTest('eyes'), true);
  assert.equal(r.tier, 'A');
  assert.equal(r.capped, false);
});

/* ------------------------------------------------------- palsy override */

test('the palsy marker withholds the urgent tier and explains why', () => {
  const r = applyPalsyOverride('D', true);
  assert.equal(r.tier, 'C', 'urgent must be capped for a declared palsy baseline');
  assert.equal(r.capped, true);
  assert.match(r.note, /面瘫/);
});

test('the palsy marker leaves the milder tiers untouched', () => {
  for (const t of ['A', 'B', 'C']) {
    const r = applyPalsyOverride(t, true);
    assert.equal(r.tier, t);
    assert.equal(r.capped, false);
    assert.equal(r.note, null);
  }
});

test('without the marker nothing changes', () => {
  for (const t of TIER_ORDER) {
    const r = applyPalsyOverride(t, false);
    assert.equal(r.tier, t);
    assert.equal(r.capped, false);
  }
});

test('a missing tier is passed through rather than invented', () => {
  assert.equal(applyPalsyOverride(null, true).tier, null);
  assert.equal(applyPalsyOverride(undefined, true).tier, null);
  assert.equal(applyPalsyOverride(null, false).tier, null);
});

/* ------------------------------------------------------------ same day */

test('localDateOf formats a local calendar day', () => {
  assert.equal(localDateOf(new Date(2026, 9, 1, 12, 0, 0)), '2026-10-01');
  assert.equal(localDateOf('2026-10-01T00:30:00.000Z'), localDateOf(new Date('2026-10-01T00:30:00.000Z')));
  assert.equal(localDateOf('not a date'), null);
});

test('sameDayCount counts only records from the same local day', () => {
  const now = new Date(2026, 9, 1, 15, 0, 0);
  const records = [
    { timestamp: new Date(2026, 8, 30, 10, 0, 0).toISOString() },
    { timestamp: new Date(2026, 9, 1, 9, 0, 0).toISOString() },
    { timestamp: new Date(2026, 9, 1, 14, 0, 0).toISOString() },
  ];
  assert.equal(sameDayCount(records, now), 2);
  assert.equal(sameDayCount([], now), 0);
  assert.equal(sameDayCount(null, now), 0);
});

test('the anti-refresh note only appears from the second test of the day', () => {
  assert.equal(antiRefreshNote(0), null);
  assert.equal(antiRefreshNote(1), null, 'the first test of the day says nothing');
  assert.match(antiRefreshNote(2), /第 2 次/);
  assert.match(antiRefreshNote(2), /不会改变真实情况/);
  assert.equal(antiRefreshNote(Number.NaN), null);
});

/* -------------------------------------------------------- pacing budget */

test('the expected detection duration lands inside the 20-30 s design window', () => {
  const pacing = { analysisMinMs: 8000, analysisMaxMs: 12000 };
  const capture = { countdownSeconds: 3, framesToCapture: 10 };
  const d = expectedDurationSeconds(pacing, capture);
  assert.equal(d.analysis, 10);
  assert.equal(d.capture, 3 + 1 + 6);
  assert.ok(d.total >= 20 && d.total <= 30, `expected 20-30 s, got ${d.total}`);
});

test('pacing falls back to the spec defaults when config is missing', () => {
  const d = expectedDurationSeconds(undefined, undefined);
  assert.equal(d.analysis, 10);
  assert.ok(d.total >= 20 && d.total <= 30);
});
