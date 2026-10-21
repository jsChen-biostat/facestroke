/**
 * Unit tests for the records trend logic (web/src/core/trend.js).
 * Spec: 03 功能规格 S10
 *
 * Run: cd web && npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  summarizeTrend, chartPoints, recordRow,
  TREND_PHRASE, STABLE_BAND, VOLATILE_SPREAD, MIN_POINTS,
} from '../src/core/trend.js';

const rec = (day, score, tier = null) => ({ timestamp: `2026-09-${String(day).padStart(2, '0')}T10:00:00.000Z`, score, tier });

test('an empty history is reported as insufficient, not as a zero trend', () => {
  const s = summarizeTrend([]);
  assert.equal(s.n, 0);
  assert.equal(s.latest, null);
  assert.equal(s.direction, 'insufficient');
  assert.equal(s.phrase, TREND_PHRASE.insufficient);
});

test('a single record gives the latest score and no delta', () => {
  const s = summarizeTrend([rec(1, 80)]);
  assert.equal(s.n, 1);
  assert.equal(s.latest, 80);
  assert.equal(s.previous, null);
  assert.equal(s.delta, null);
  assert.equal(s.direction, 'insufficient');
});

test('small changes read as stable', () => {
  const s = summarizeTrend([rec(1, 80), rec(2, 82)]);
  assert.equal(s.delta, 2);
  assert.equal(s.direction, 'stable');
  assert.equal(s.phrase, TREND_PHRASE.stable);
});

test('a rise reads as improving and a fall as worsening', () => {
  const up = summarizeTrend([rec(1, 60), rec(2, 70)]);
  assert.equal(up.direction, 'improving');
  const down = summarizeTrend([rec(1, 70), rec(2, 55)]);
  assert.equal(down.direction, 'worsening');
});

test('a large spread is flagged volatile even when the last step is small', () => {
  const s = summarizeTrend([rec(1, 30), rec(2, 90), rec(3, 89)]);
  assert.ok(s.spread > VOLATILE_SPREAD);
  assert.equal(s.direction, 'volatile');
  assert.equal(s.phrase, TREND_PHRASE.volatile);
});

test('the stable band boundary is inclusive of small moves', () => {
  assert.equal(summarizeTrend([rec(1, 70), rec(2, 70 + STABLE_BAND - 1)]).direction, 'stable');
  assert.equal(summarizeTrend([rec(1, 70), rec(2, 70 + STABLE_BAND)]).direction, 'improving');
});

test('records are sorted by timestamp before summarising', () => {
  const s = summarizeTrend([rec(3, 70), rec(1, 50), rec(2, 60)]);
  assert.equal(s.latest, 70);
  assert.equal(s.previous, 60);
  assert.equal(s.delta, 10);
});

test('malformed records are ignored rather than breaking the summary', () => {
  const s = summarizeTrend([rec(1, 50), null, { timestamp: 'x' }, { timestamp: '2026-09-02', score: Number.NaN }, rec(2, 60)]);
  assert.equal(s.n, 2);
  assert.equal(s.latest, 60);
});

test('MIN_POINTS is honoured', () => {
  assert.equal(MIN_POINTS, 2);
  assert.equal(summarizeTrend([rec(1, 50)]).direction, 'insufficient');
  assert.notEqual(summarizeTrend([rec(1, 50), rec(2, 50)]).direction, 'insufficient');
});

/* ---------------------------------------------------------------- charting */

test('chartPoints maps scores into the padded plotting area', () => {
  const r = chartPoints([rec(1, 0), rec(2, 100)], { width: 200, height: 120, padding: 20 });
  assert.equal(r.points.length, 2);
  assert.equal(r.points[0].x, 20);
  assert.equal(r.points[1].x, 180);
  // score 0 sits at the bottom of the inner area, 100 at the top
  assert.equal(Math.round(r.points[0].y), 100);
  assert.equal(Math.round(r.points[1].y), 20);
});

test('chartPoints centres a single point and still returns ticks', () => {
  const r = chartPoints([rec(1, 55)], { width: 200, height: 120, padding: 20 });
  assert.equal(r.points.length, 1);
  assert.equal(r.points[0].x, 100);
  assert.equal(r.yTicks.length, 3);
  assert.equal(r.xLabels.length, 1);
});

test('chartPoints tolerates an empty history', () => {
  const r = chartPoints([], { width: 200, height: 120, padding: 20 });
  assert.deepEqual(r.points, []);
  assert.equal(r.yTicks.length, 3);
});

test('chartPoints respects a custom score range', () => {
  const r = chartPoints([rec(1, 50)], { width: 200, height: 120, padding: 20, minScore: 40, maxScore: 60 });
  assert.equal(Math.round(r.points[0].y), 60, 'mid-range score should sit midway');
});

test('recordRow formats date, score and tier', () => {
  const row = recordRow(rec(5, 77, 'B'));
  assert.equal(row.date, '2026-09-05');
  assert.equal(row.score, 77);
  assert.equal(row.tier, 'B');
  assert.equal(recordRow({ timestamp: '', score: 10 }).tier, '—');
});
