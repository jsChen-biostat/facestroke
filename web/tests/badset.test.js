/**
 * G4 regression: bad-image rejection.
 * Spec: 08_测试与内测方案 §2, 03 功能规格 S5
 *
 * Runs the REAL quality-gate functions on REAL pixel data (raw RGBA exported by
 * train/build_badset.py) plus real landmark arrays, using the SHIPPED thresholds
 * from core/config.js.
 *
 * A control group of clean frames is included: if the gate rejected everything,
 * the control assertions here would fail. That is what stops "100% rejection"
 * from being trivially true.
 *
 * Run: cd web && npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  luminanceStats, laplacianVariance, yawProxyOf, faceWidthRatioOf,
  mouthFlatnessRatio, assessFrame, REASON,
} from '../src/core/quality.js';
import { CONFIG } from '../src/core/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..', 'work', 'badset');
const SKIP = !existsSync(join(ROOT, 'manifest.json'))
  && 'work/badset 未随仓库分发：用 train/build_badset.py 在你自己的数据上生成后再跑';
const manifest = SKIP ? { frames: [] } : JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const CFG = CONFIG.quality;

const BAD_KINDS = ['dark', 'bright', 'blurry', 'occluded', 'turned', 'far', 'noface', 'multi'];

function metricsFor(c) {
  const buf = readFileSync(join(ROOT, c.file));
  const rgba = new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.byteLength);
  const lum = luminanceStats(rgba);
  const sharpness = laplacianVariance(rgba, c.w, c.h);

  let landmarks = null;
  if (c.landmarks) {
    // the Python builder writes [[x, y, z], ...]; the JS helpers want {x, y, z}.
    // Getting this wrong made the landmark helpers return Infinity / 0, which a
    // weaker test would have accepted as "the gate fired".
    const raw = JSON.parse(readFileSync(join(ROOT, c.landmarks), 'utf8'));
    landmarks = raw.map(([x, y, z]) => ({ x, y, z }));
  }
  const faceFound = Array.isArray(landmarks) && landmarks.length >= 468;
  const face = faceFound ? landmarks : null;

  return {
    faceFound,
    faceCount: c.kind === 'multi' ? 2 : (faceFound ? 1 : 0),
    brightness: lum.mean,
    brightnessP5: lum.p5,
    brightnessP95: lum.p95,
    sharpness,
    yawProxy: face ? yawProxyOf(face) : Infinity,
    faceWidthRatio: face ? faceWidthRatioOf(face) : 0,
    mouthFlatness: face ? mouthFlatnessRatio(face, rgba, c.w, c.h) : null,
  };
}

test('the bad-image set is present', { skip: SKIP }, () => {
  assert.ok(manifest.cases.length >= 40, `expected a populated bad set, got ${manifest.cases.length}`);
  for (const k of ['good', ...BAD_KINDS]) {
    assert.ok(manifest.cases.some((c) => c.kind === k), `missing kind ${k}`);
  }
});

test('CONTROL: clean frames pass the gate (the gate is not rejecting everything)', { skip: SKIP }, () => {
  const goods = manifest.cases.filter((c) => c.kind === 'good');
  const failures = [];
  for (const c of goods) {
    const m = metricsFor(c);
    const r = assessFrame(m, CFG);
    if (!r.passed) {
      failures.push(`${c.id}: ${r.reasons.join(',')} (sharp=${m.sharpness.toFixed(1)} bright=${m.brightness.toFixed(0)} yaw=${m.yawProxy.toFixed(3)} width=${m.faceWidthRatio.toFixed(2)} mouth=${m.mouthFlatness === null ? 'n/a' : m.mouthFlatness.toFixed(2)})`);
    }
  }
  assert.deepEqual(failures, [], `control frames must pass:\n${failures.join('\n')}`);
});

test('G4: every bad frame is rejected', { skip: SKIP }, () => {
  const bad = manifest.cases.filter((c) => BAD_KINDS.includes(c.kind));
  const accepted = [];
  const perKind = {};
  for (const c of bad) {
    const m = metricsFor(c);
    const r = assessFrame(m, CFG);
    perKind[c.kind] = perKind[c.kind] || { total: 0, rejected: 0 };
    perKind[c.kind].total += 1;
    if (r.passed) accepted.push(`${c.id} (${c.kind})`);
    else perKind[c.kind].rejected += 1;
  }
  const rates = Object.entries(perKind)
    .map(([k, v]) => `${k}: ${v.rejected}/${v.total}`)
    .join('  ');
  assert.deepEqual(accepted, [], `these bad frames were accepted: ${accepted.join(', ')}\nrates: ${rates}`);
  for (const [k, v] of Object.entries(perKind)) {
    assert.equal(v.rejected, v.total, `${k} rejection rate must be 100% (${rates})`);
  }
});

test('each failure carries an actionable reason', { skip: SKIP }, () => {
  const bad = manifest.cases.filter((c) => BAD_KINDS.includes(c.kind));
  for (const c of bad) {
    const r = assessFrame(metricsFor(c), CFG);
    assert.ok(r.reasons.length > 0, `${c.id} must report at least one reason`);
    for (const reason of r.reasons) {
      assert.ok(Object.values(REASON).includes(reason), `${c.id} unknown reason ${reason}`);
    }
  }
});

test('the pixel gates fire for the pixel degradations specifically', { skip: SKIP }, () => {
  const pick = (kind) => manifest.cases.filter((c) => c.kind === kind).map(metricsFor);

  const dark = pick('dark').map((m) => assessFrame(m, CFG));
  assert.ok(dark.every((r) => r.reasons.includes(REASON.TOO_DARK)), 'dark frames must be flagged TOO_DARK');

  const bright = pick('bright').map((m) => assessFrame(m, CFG));
  assert.ok(bright.every((r) => r.reasons.includes(REASON.TOO_BRIGHT)), 'bright frames must be flagged TOO_BRIGHT');

  const blurry = pick('blurry').map((m) => assessFrame(m, CFG));
  assert.ok(blurry.every((r) => r.reasons.includes(REASON.BLURRY)), 'blurry frames must be flagged BLURRY');
});

test('the landmark gates fire for their specific degradations', { skip: SKIP }, () => {
  const turned = manifest.cases.filter((c) => c.kind === 'turned').map(metricsFor);
  assert.ok(turned.every((m) => m.faceFound), 'turned cases must actually load landmarks');
  assert.ok(turned.every((m) => m.yawProxy > CFG.maxYawProxy), 'shifted nose must exceed the yaw gate');
  assert.ok(turned.every((m) => Number.isFinite(m.yawProxy)), 'yaw must be a real number, not Infinity');

  const far = manifest.cases.filter((c) => c.kind === 'far').map(metricsFor);
  assert.ok(far.every((m) => m.faceFound), 'far cases must actually load landmarks');
  assert.ok(far.every((m) => m.faceWidthRatio < CFG.minFaceWidthRatio), 'scaled landmarks must be too small');
  assert.ok(far.every((m) => m.faceWidthRatio > 0), 'width must be a real measurement, not a zero from a bad loader');

  const noface = manifest.cases.filter((c) => c.kind === 'noface').map(metricsFor);
  assert.ok(noface.every((m) => !m.faceFound), 'noface cases must report no face');

  // the control group must genuinely have landmarks, otherwise every landmark
  // assertion above could pass for the wrong reason
  const good = manifest.cases.filter((c) => c.kind === 'good').map(metricsFor);
  assert.ok(good.every((m) => m.faceFound), 'control frames must load landmarks');
  assert.ok(good.every((m) => m.faceWidthRatio > 0), 'control frames must have a real face width');
});

test('the occlusion heuristic actually separates covered from uncovered mouths', { skip: SKIP }, () => {
  const goodMouth = manifest.cases.filter((c) => c.kind === 'good').map((c) => metricsFor(c).mouthFlatness);
  const occludedMouth = manifest.cases.filter((c) => c.kind === 'occluded').map((c) => metricsFor(c).mouthFlatness);
  const gAvg = goodMouth.reduce((a, b) => a + b, 0) / goodMouth.length;
  const oAvg = occludedMouth.reduce((a, b) => a + b, 0) / occludedMouth.length;
  assert.ok(oAvg < gAvg, `a covered mouth must read flatter (good=${gAvg.toFixed(3)} occluded=${oAvg.toFixed(3)})`);
});
