/**
 * Unit tests for the geometric channel (web/src/core/symmetry.js).
 *
 * The important test is the cross-validation: the same landmarks are scored by
 * the Python reference implementation (train/derive_mirror_pairs.py) and by the
 * JS that actually runs on the phone. If they diverge, one of them is wrong.
 *
 * Run: cd web && npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  AXIS, PAIRS, ZONE_NAMES, ANCHORS,
  align, mirrorAcross, zoneAsymmetry, overallAsymmetry, scoreFromAsymmetry,
  computeGeometry, aggregateFrames, CALIBRATION,
} from '../src/core/symmetry.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, 'fixtures', 'landmarks_sample.json'), 'utf8'),
);

const toLandmarks = (triples) => triples.map(([x, y, z]) => ({ x, y, z }));

test('fixture is present and plausible', () => {
  assert.ok(fixture.samples.length >= 5, 'need at least 5 cross-validation samples');
  assert.ok(PAIRS.length >= 200, `expected a rich mirror table, got ${PAIRS.length}`);
  assert.deepEqual(AXIS, [168, 152]);
});

test('cross-validation: JS matches the Python reference implementation', () => {
  for (const s of fixture.samples) {
    const lm = toLandmarks(s.landmarks);
    const res = zoneAsymmetry(lm);
    assert.ok(res, `no result for ${s.file}`);

    const aJs = overallAsymmetry(res.zones, null);
    const aPy = s.python.a;
    assert.ok(
      Math.abs(aJs - aPy) < 1e-6,
      `${s.file}: A differs (js=${aJs} python=${aPy})`,
    );

    for (const z of ZONE_NAMES) {
      if (s.python.zones[z] === undefined) continue;
      assert.ok(
        Math.abs(res.zones[z] - s.python.zones[z]) < 1e-6,
        `${s.file}: zone ${z} differs (js=${res.zones[z]} python=${s.python.zones[z]})`,
      );
    }
  }
});

/**
 * Build a face that is symmetric BY CONSTRUCTION: for every mirror pair (i, j),
 * put j exactly at the mirror of i. Any remaining asymmetry then comes from the
 * code under test, not from the input.
 *
 * NOTE: use the module's own mirrorAcross. A local copy of it once diverged from
 * the implementation and produced a false failure - do not reintroduce one.
 */
function symmetrise(lm) {
  const aligned = align(lm);
  const a = aligned[AXIS[0]];
  const b = aligned[AXIS[1]];
  const out = aligned.map((p) => ({ x: p.x, y: p.y }));
  for (const [i, j] of PAIRS) out[j] = mirrorAcross(aligned[i], a, b);
  return out.map((p, i) => ({ x: p.x, y: p.y, z: lm[i].z }));
}

test('a perfectly mirrored face scores ~100 with ~0 asymmetry', () => {
  const lm = toLandmarks(fixture.samples[0].landmarks);
  const symmetric = symmetrise(lm);

  const res = zoneAsymmetry(symmetric);
  assert.ok(res, 'symmetric face must still be scorable');
  const aVal = overallAsymmetry(res.zones, null);
  assert.ok(aVal < 1e-9, `expected ~zero asymmetry, got ${aVal}`);

  const score = scoreFromAsymmetry(aVal, CALIBRATION.aRef, CALIBRATION.aMax);
  assert.equal(score, 100, `symmetric face should score 100, got ${score}`);
});

test('a droop on one side raises asymmetry monotonically and lowers the score', () => {
  const lm = toLandmarks(fixture.samples[0].landmarks);
  const symmetric = symmetrise(lm);

  const base = computeGeometry(symmetric, { zoneWeights: null });
  assert.ok(base);
  assert.equal(base.score, 100, 'baseline must start perfectly symmetric');
  assert.ok(base.a < 1e-9, `baseline A must be ~0, got ${base.a}`);

  const as = [base.a];
  const scores = [base.score];
  for (const amount of [0.01, 0.02, 0.04, 0.08]) {
    // drop the right-hand half (canonical x > 0) to simulate a facial droop
    const drooped = symmetric.map((p) => (p.x > 0.15 ? { x: p.x, y: p.y + amount, z: p.z } : { ...p }));
    const r = computeGeometry(drooped, { zoneWeights: null });
    assert.ok(r, 'drooped face should still produce a result');
    as.push(r.a);
    scores.push(r.score);
  }

  // Asymmetry must grow monotonically with the amount of droop. This is the
  // property that matters; the 0-100 score saturates at 100 while A is still
  // below the population reference (aRef), which is intended behaviour.
  for (let i = 1; i < as.length; i += 1) {
    assert.ok(
      as[i] >= as[i - 1] - 1e-12,
      `A should not decrease with more droop: ${JSON.stringify(as)}`,
    );
  }
  assert.ok(as[as.length - 1] > as[0] + 0.05, `large droop must raise A clearly: ${JSON.stringify(as)}`);
  assert.ok(scores[scores.length - 1] < 100, 'a large droop must eventually cost score');
  assert.ok(scores[scores.length - 1] < scores[0]);
});

test('score is invariant to translation, rotation and scale', () => {
  const lm = toLandmarks(fixture.samples[1].landmarks);
  const ref = computeGeometry(lm, { zoneWeights: null });

  const th = 0.3;
  const c = Math.cos(th);
  const s = Math.sin(th);
  const transformed = lm.map((p) => {
    const x = p.x * 2.5;
    const y = p.y * 2.5;
    return { x: x * c - y * s + 0.4, y: x * s + y * c - 0.2, z: p.z };
  });
  const got = computeGeometry(transformed, { zoneWeights: null });

  assert.ok(Math.abs(ref.a - got.a) < 1e-9, `A should be invariant (${ref.a} vs ${got.a})`);
  assert.equal(ref.score, got.score);
});

test('degenerate input yields null instead of a bogus score', () => {
  assert.equal(computeGeometry(null), null);
  assert.equal(computeGeometry([]), null);
  assert.equal(
    computeGeometry(Array.from({ length: 478 }, () => ({ x: 0, y: 0, z: 0 }))),
    null,
    'zero inter-ocular distance must not produce a score',
  );
});

test('multi-frame aggregation is robust to one outlier', () => {
  const lm = toLandmarks(fixture.samples[2].landmarks);
  const good = computeGeometry(lm, { zoneWeights: null });
  const outlier = { score: 3, zones: good.zones, a: 0.5, pairs: [] };
  const agg = aggregateFrames([good, good, outlier]);
  assert.ok(agg);
  assert.equal(agg.nFrames, 3);
  assert.equal(agg.score, good.score, 'median must ignore the single outlier');
  assert.ok(agg.spread > 0, 'spread must be reported for the stability rule');
});

test('anchor indices exist in a real 478-point set', () => {
  const lm = toLandmarks(fixture.samples[0].landmarks);
  assert.equal(lm.length, 478);
  for (const key of ['eye_r_outer', 'eye_l_outer', 'nasion', 'chin']) {
    const idx = ANCHORS[key];
    assert.ok(lm[idx], `anchor ${key} (${idx}) missing`);
  }
});
