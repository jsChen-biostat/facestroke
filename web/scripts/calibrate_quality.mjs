/**
 * T-17: calibrate the capture-quality thresholds from the bad-image set.
 *
 * The gate thresholds were placeholders. The control group showed they were too
 * strict: 5 of 8 clean frames failed on sharpness and 2 of 8 on yaw. This script
 * prints the actual distributions so the thresholds can be chosen from data,
 * the same way the geometric calibration anchors were.
 *
 * Usage: cd web && node scripts/calibrate_quality.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  luminanceStats, laplacianVariance, yawProxyOf, faceWidthRatioOf,
  mouthFlatnessRatio,
} from '../src/core/quality.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..', 'work', 'badset');
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

function metrics(c) {
  const buf = readFileSync(join(ROOT, c.file));
  const rgba = new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.byteLength);
  const lum = luminanceStats(rgba);
  const sharpness = laplacianVariance(rgba, c.w, c.h);
  let lm = null;
  if (c.landmarks) {
    lm = JSON.parse(readFileSync(join(ROOT, c.landmarks), 'utf8')).map(([x, y, z]) => ({ x, y, z }));
  }
  const found = Array.isArray(lm) && lm.length >= 468;
  return {
    brightness: lum.mean,
    sharpness,
    yaw: found ? yawProxyOf(lm) : null,
    width: found ? faceWidthRatioOf(lm) : null,
    mouth: found ? mouthFlatnessRatio(lm, rgba, c.w, c.h) : null,
  };
}

const kinds = ['good', 'dark', 'bright', 'blurry', 'turned', 'far', 'occluded', 'noface', 'multi'];
const table = {};
for (const k of kinds) {
  table[k] = manifest.cases.filter((c) => c.kind === k).map(metrics);
}

const fmt = (v, d = 3) => (v === null || v === undefined ? '  n/a' : v.toFixed(d).padStart(7));
function summarize(field, decimals = 3) {
  console.log(`\n${field}`);
  console.log('  kind        min     median      max   values');
  for (const k of kinds) {
    const vals = table[k].map((m) => m[field]).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (!vals.length) { console.log(`  ${k.padEnd(10)}   (none)`); continue; }
    const med = vals[Math.floor(vals.length / 2)];
    console.log(`  ${k.padEnd(10)} ${fmt(vals[0], decimals)} ${fmt(med, decimals)} ${fmt(vals[vals.length - 1], decimals)}   ${vals.map((v) => v.toFixed(decimals)).join(' ')}`);
  }
}

console.log('=== capture-quality threshold calibration ===');
console.log(`cases: ${manifest.cases.length}`);
summarize('brightness', 1);
summarize('sharpness', 1);
summarize('yaw');
summarize('width');
summarize('mouth');

console.log('\n=== candidate thresholds ===');
const good = table.good;
const blurry = table.blurry;

function pick(field, acceptAll, rejectAll, label) {
  const acceptMax = Math.max(...acceptAll.map((m) => m[field]).filter(Number.isFinite));
  const rejectMin = Math.min(...rejectAll.map((m) => m[field]).filter(Number.isFinite));
  const separable = rejectMin > acceptMax;
  const mid = separable ? (acceptMax + rejectMin) / 2 : null;
  console.log(`  ${label}: good max=${acceptMax.toFixed(3)}  bad min=${rejectMin.toFixed(3)}  `
    + (separable ? `separable -> threshold ~ ${mid.toFixed(3)}` : 'NOT separable with this split'));
  return mid;
}

pick('sharpness', good, blurry, 'sharpness(good vs blurry)');
const goodYaw = Math.max(...good.map((m) => m.yaw).filter(Number.isFinite));
const turnedYaw = Math.min(...table.turned.map((m) => m.yaw).filter(Number.isFinite));
console.log(`  yaw: good max=${goodYaw.toFixed(3)}  turned min=${turnedYaw.toFixed(3)}  `
  + (turnedYaw > goodYaw ? `separable -> threshold ~ ${((goodYaw + turnedYaw) / 2).toFixed(3)}` : 'NOT separable'));

const goodWidth = Math.min(...good.map((m) => m.width).filter(Number.isFinite));
const farWidth = Math.max(...table.far.map((m) => m.width).filter(Number.isFinite));
console.log(`  width: good min=${goodWidth.toFixed(3)}  far max=${farWidth.toFixed(3)}  `
  + (goodWidth > farWidth ? `separable -> threshold ~ ${((goodWidth + farWidth) / 2).toFixed(3)}` : 'NOT separable'));

const goodMouth = Math.min(...good.map((m) => m.mouth).filter(Number.isFinite));
const occlMouth = Math.max(...table.occluded.map((m) => m.mouth).filter(Number.isFinite));
console.log(`  mouth: good min=${goodMouth.toFixed(3)}  occluded max=${occlMouth.toFixed(3)}  `
  + (goodMouth > occlMouth ? `separable -> threshold ~ ${((goodMouth + occlMouth) / 2).toFixed(3)}` : 'NOT separable'));
