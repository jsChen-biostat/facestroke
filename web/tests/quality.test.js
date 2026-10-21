/**
 * Unit tests for the capture quality gate (web/src/core/quality.js).
 *
 * The gate is a product red line: an image that fails it must never produce a
 * score. These tests pin down the decision logic and the focus/light measures on
 * synthetic pixels, so the thresholds can be re-tuned later without silently
 * changing behaviour.
 *
 * Run: cd web && npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REASON, INSTRUCTION, luminanceStats, laplacianVariance,
  yawProxyOf, faceWidthRatioOf, assessFrame, primaryInstruction,
  pickBestFrames, burstSpread, isUnstable,
} from '../src/core/quality.js';

const CFG = {
  minBrightnessMean: 55,
  maxBrightnessMean: 225,
  maxYawProxy: 0.15,
  minFaceWidthRatio: 0.28,
  minSharpness: 45,
  minMouthFlatness: 0.35,
  maxFrameSpread: null,
};

/** Build an RGBA buffer of one flat grey level. */
function flat(w, h, level) {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    a[i * 4] = level;
    a[i * 4 + 1] = level;
    a[i * 4 + 2] = level;
    a[i * 4 + 3] = 255;
  }
  return a;
}

/** Flat grey with a bright checkerboard in the middle (high local contrast). */
function textured(w, h, base, amp) {
  const a = flat(w, h, base);
  for (let y = Math.floor(h * 0.25); y < Math.floor(h * 0.75); y += 1) {
    for (let x = Math.floor(w * 0.25); x < Math.floor(w * 0.75); x += 1) {
      const v = ((x + y) % 2 === 0) ? base + amp : base - amp;
      const o = (y * w + x) * 4;
      a[o] = v; a[o + 1] = v; a[o + 2] = v;
    }
  }
  return a;
}

const goodFace = () => {
  // minimal 478-point stand-in: anchors used by the helpers plus a spread of x
  const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  lm[33] = { x: 0.35, y: 0.45, z: 0 };   // right eye outer
  lm[263] = { x: 0.65, y: 0.45, z: 0 };  // left eye outer
  lm[168] = { x: 0.50, y: 0.35, z: 0 };  // nasion
  lm[152] = { x: 0.50, y: 0.85, z: 0 };  // chin
  lm[1] = { x: 0.50, y: 0.60, z: 0 };    // nose tip (centred -> frontal)
  lm[100] = { x: 0.22, y: 0.5, z: 0 };   // widest point left
  lm[300] = { x: 0.78, y: 0.5, z: 0 };   // widest point right
  return lm;
};

/* ------------------------------------------------------------------ pixels */

test('luminanceStats measures a flat grey correctly', () => {
  const s = luminanceStats(flat(16, 16, 120));
  assert.ok(Math.abs(s.mean - 120) < 0.5, `mean=${s.mean}`);
  assert.ok(Math.abs(s.p5 - 120) < 0.5 && Math.abs(s.p95 - 120) < 0.5);
});

test('laplacianVariance is ~0 on a flat image and large on an edge-rich one', () => {
  const flatVar = laplacianVariance(flat(64, 64, 128), 64, 64);
  const texVar = laplacianVariance(textured(64, 64, 128, 60), 64, 64);
  assert.ok(flatVar < 1e-6, `flat should have no focus, got ${flatVar}`);
  assert.ok(texVar > 1000, `texture should score high, got ${texVar}`);
});

/* --------------------------------------------------------------- landmarks */

test('yawProxyOf is ~0 for a centred nose and grows when it shifts', () => {
  const lm = goodFace();
  assert.ok(yawProxyOf(lm) < 0.02, 'centred nose should read as frontal');

  const turned = goodFace();
  turned[1] = { x: 0.58, y: 0.60, z: 0 }; // nose pushed toward the left eye
  assert.ok(yawProxyOf(turned) > 0.15, 'turned face should exceed the gate');
});

test('faceWidthRatioOf reports the horizontal face extent', () => {
  const lm = goodFace();
  const ratio = faceWidthRatioOf(lm);
  assert.ok(Math.abs(ratio - 0.56) < 0.02, `expected ~0.56, got ${ratio}`);
});

test('degenerate landmarks do not crash the helpers', () => {
  assert.equal(yawProxyOf(null), Infinity);
  assert.equal(faceWidthRatioOf([]), 0);
  const zero = Array.from({ length: 478 }, () => ({ x: 0, y: 0, z: 0 }));
  assert.equal(yawProxyOf(zero), Infinity, 'zero eye distance must not divide by zero');
});

/* ------------------------------------------------------------------- gate */

const okMetrics = () => ({
  faceFound: true,
  faceCount: 1,
  brightness: 130,
  brightnessP5: 100,
  brightnessP95: 180,
  sharpness: 300,
  yawProxy: 0.05,
  faceWidthRatio: 0.5,
  mouthFlatness: 1.0,
});

test('a good frame passes with all four lamps lit', () => {
  const r = assessFrame(okMetrics(), CFG);
  assert.equal(r.passed, true);
  assert.deepEqual(r.reasons, []);
  assert.deepEqual(r.lamps, { light: true, frontal: true, distance: true, clear: true });
});

test('a dark frame is rejected and the light lamp goes out', () => {
  const m = okMetrics();
  m.brightness = 20;
  const r = assessFrame(m, CFG);
  assert.equal(r.passed, false);
  assert.ok(r.reasons.includes(REASON.TOO_DARK));
  assert.equal(r.lamps.light, false);
  assert.equal(primaryInstruction(r.reasons), INSTRUCTION[REASON.TOO_DARK]);
});

test('a blown-out frame is rejected', () => {
  const m = okMetrics();
  m.brightness = 240;
  const r = assessFrame(m, CFG);
  assert.ok(r.reasons.includes(REASON.TOO_BRIGHT));

  const m2 = okMetrics();
  m2.brightnessP95 = 255;
  m2.brightnessP5 = 230;
  assert.ok(assessFrame(m2, CFG).reasons.includes(REASON.TOO_BRIGHT));
});

test('a turned or too-far face is rejected', () => {
  const turned = okMetrics();
  turned.yawProxy = 0.3;
  const r1 = assessFrame(turned, CFG);
  assert.ok(r1.reasons.includes(REASON.NOT_FRONTAL));
  assert.equal(r1.lamps.frontal, false);

  const far = okMetrics();
  far.faceWidthRatio = 0.1;
  const r2 = assessFrame(far, CFG);
  assert.ok(r2.reasons.includes(REASON.TOO_FAR));
  assert.equal(r2.lamps.distance, false);
});

test('a blurry frame is rejected', () => {
  const m = okMetrics();
  m.sharpness = 5;
  const r = assessFrame(m, CFG);
  assert.ok(r.reasons.includes(REASON.BLURRY));
  assert.equal(r.lamps.clear, false);
});

test('a flattened lower face reads as occluded', () => {
  const m = okMetrics();
  m.mouthFlatness = 0.1;
  const r = assessFrame(m, CFG);
  assert.ok(r.reasons.includes(REASON.OCCLUDED));
  assert.equal(primaryInstruction(r.reasons), INSTRUCTION[REASON.OCCLUDED]);
});

test('no face at all short-circuits with the right instruction', () => {
  const r = assessFrame({ faceFound: false, faceCount: 0 }, CFG);
  assert.equal(r.passed, false);
  assert.deepEqual(r.reasons, [REASON.NO_FACE]);
  assert.equal(primaryInstruction(r.reasons), INSTRUCTION[REASON.NO_FACE]);
});

test('two faces in frame are rejected', () => {
  const m = okMetrics();
  m.faceCount = 2;
  const r = assessFrame(m, CFG);
  assert.ok(r.reasons.includes(REASON.MULTI_FACE));
});

test('a wall of failures still yields one actionable instruction', () => {
  const r = assessFrame({
    faceFound: true, faceCount: 1, brightness: 10, brightnessP5: 5,
    brightnessP95: 20, sharpness: 1, yawProxy: 0.9, faceWidthRatio: 0.05, mouthFlatness: 0.01,
  }, CFG);
  assert.equal(r.passed, false);
  assert.ok(r.reasons.length >= 4);
  const text = primaryInstruction(r.reasons);
  assert.ok(text && text.length > 4 && !text.includes('undefined'));
  assert.equal(text, INSTRUCTION[REASON.TOO_DARK], 'priority order should prefer the light problem');
});

/* ------------------------------------------------------------- burst pick */

test('pickBestFrames prefers sharp, frontal frames and keeps order', () => {
  const burst = [
    { sharpness: 10, yawProxy: 0.01 },  // blurry
    { sharpness: 900, yawProxy: 0.02 }, // best
    { sharpness: 400, yawProxy: 0.30 }, // sharp but turned
    { sharpness: 700, yawProxy: 0.05 }, // second best
  ];
  assert.deepEqual(pickBestFrames(burst, 2), [1, 3]);
});

test('pickBestFrames never returns more than it was given', () => {
  assert.equal(pickBestFrames([{ sharpness: 1, yawProxy: 0 }], 3).length, 1);
  assert.deepEqual(pickBestFrames([], 3), []);
});

test('burst spread drives the unstable-capture rule', () => {
  assert.equal(burstSpread([80, 82, 86]), 6);
  assert.equal(burstSpread([80]), 0);
  // until a threshold is approved, nothing is flagged unstable
  assert.equal(isUnstable(99, CFG), false);
  assert.equal(isUnstable(99, { maxFrameSpread: 5 }), true);
  assert.equal(isUnstable(Number.NaN, { maxFrameSpread: 5 }), true);
});
