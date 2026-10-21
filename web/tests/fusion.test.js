/**
 * Unit tests for two-channel fusion (web/src/core/fusion.js).
 * Spec: 05b §5 (including the cross-check downgrade rule)
 *
 * Run: cd web && npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { fuse, median, cnnHardReject, FUSION_VERSION } from '../src/core/fusion.js';

const SCORED = { geo: 0.7, cnn: 0.3, role: 'scored' };
const CROSS = { geo: 1.0, cnn: 0.0, role: 'cross-check' };

test('weighted mode blends the two channels', () => {
  const r = fuse(80, 60, SCORED, 25);
  assert.equal(r.cnnUsed, true);
  assert.equal(r.cnnRole, 'scored');
  assert.equal(r.score, 74); // 0.7*80 + 0.3*60
  assert.equal(r.conflict, false);
  assert.equal(r.gap, 20);
});

test('a missing CNN score falls back to the geometric channel and says so', () => {
  const r = fuse(72, null, SCORED, 25);
  assert.equal(r.score, 72);
  assert.equal(r.cnnUsed, false, 'must not claim the CNN contributed');
  const r2 = fuse(72, Number.NaN, SCORED, 25);
  assert.equal(r2.score, 72);
  assert.equal(r2.cnnUsed, false);
});

test('a missing geometric score produces no result at all', () => {
  assert.equal(fuse(null, 50, SCORED, 25).score, null);
  assert.equal(fuse(Number.NaN, 50, CROSS, 25).score, null);
});

test('cross-check mode never lets the CNN move the score', () => {
  const r = fuse(85, 20, CROSS, 25);
  assert.equal(r.score, 85, 'score must stay geometric');
  assert.equal(r.cnnUsed, true, 'but the cross-check did run');
  assert.equal(r.cnnRole, 'cross-check');
  assert.equal(r.conflict, true, 'a 65 point gap must be flagged');
});

test('cross-check mode still flags agreement versus disagreement', () => {
  const agree = fuse(70, 66, CROSS, 25);
  assert.equal(agree.conflict, false);
  const disagree = fuse(70, 30, CROSS, 25);
  assert.equal(disagree.conflict, true);
  assert.equal(disagree.score, 70);
});

test('the conflict threshold is exclusive at the boundary', () => {
  assert.equal(fuse(70, 45, CROSS, 25).conflict, false, 'exactly at the gap is not a conflict');
  assert.equal(fuse(70, 44, CROSS, 25).conflict, true);
});

test('a missing conflict gap disables conflict flagging rather than guessing', () => {
  const r = fuse(10, 90, CROSS, null);
  assert.equal(r.conflict, false);
  assert.equal(r.gap, 80);
});

test('degenerate weights fall back to the geometric score', () => {
  assert.equal(fuse(64, 20, { geo: 0, cnn: 0 }, 25).score, 64);
  assert.equal(fuse(64, 20, null, 25).score, 64);
});

/* ------------------------------------------------------------------ median */

test('median ignores nulls and NaNs', () => {
  assert.equal(median([70, null, 80, Number.NaN, 90]), 80);
  assert.equal(median([60, 80]), 70);
  assert.equal(median([]), null);
  assert.equal(median([null, Number.NaN]), null);
});

/* ------------------------------------------------------- cnnHardReject */

test('only a confident hard-bad prediction may veto a capture', () => {
  const cfg = { cnnRejectConfidence: 0.85 };
  assert.equal(cnnHardReject({ label: 'ok', confidence: 0.99 }, cfg), false);
  assert.equal(cnnHardReject({ label: 'occluded', confidence: 0.9 }, cfg), true);
  assert.equal(cnnHardReject({ label: 'occluded', confidence: 0.5 }, cfg), false,
    'a low-confidence bad label must not block the user');
  assert.equal(cnnHardReject({ label: 'blurry', confidence: 0.85 }, cfg), true);
  assert.equal(cnnHardReject(null, cfg), false);
});

test('the confidence bar defaults sensibly when config is missing', () => {
  assert.equal(cnnHardReject({ label: 'too_dark', confidence: 0.86 }, undefined), true);
  assert.equal(cnnHardReject({ label: 'too_dark', confidence: 0.84 }, undefined), false);
});

test('fusion version is exposed for the model fingerprint', () => {
  assert.equal(FUSION_VERSION, 'fusion-1.0');
});
