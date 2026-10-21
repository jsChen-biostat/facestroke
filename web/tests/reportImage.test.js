/**
 * Unit tests for the shareable report image (web/src/core/reportImage.js).
 * Spec: 03 功能规格 S7 / 02 §7
 *
 * The important guarantee is the RED LINE: the exported report must never carry
 * face pixels. That is structural here - renderReportCanvas only ever receives
 * the numeric result object - and this test pins the contract down.
 *
 * A minimal canvas stub is used because Node has no DOM.
 *
 * Run: cd web && npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

/** Record every pixel-drawing call so the test can inspect what was drawn. */
function makeCanvasStub() {
  const calls = [];
  const ctx = {
    canvas: null,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    fillRect: (...a) => calls.push(['fillRect', ...a]),
    strokeRect: (...a) => calls.push(['strokeRect', ...a]),
    fillText: (t, ...a) => calls.push(['fillText', String(t), ...a]),
    beginPath: () => calls.push(['beginPath']),
    moveTo: (...a) => calls.push(['moveTo', ...a]),
    lineTo: (...a) => calls.push(['lineTo', ...a]),
    stroke: () => calls.push(['stroke']),
    measureText: (t) => ({ width: String(t).length * 12 }),
    drawImage: (...a) => calls.push(['drawImage', ...a]),
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ctx,
    toBlob: (cb) => cb({ size: 1, type: 'image/png' }),
  };
  ctx.canvas = canvas;
  return { canvas, calls };
}

function installDomStub() {
  const made = [];
  globalThis.document = {
    baseURI: 'http://localhost/',
    createElement: (tag) => {
      if (tag === 'canvas') {
        const { canvas, calls } = makeCanvasStub();
        made.push(calls);
        return canvas;
      }
      return { style: {}, appendChild() {}, remove() {}, click() {}, set href(v) {}, set download(v) {} };
    },
    body: { appendChild() {} },
  };
  globalThis.URL.createObjectURL = () => 'blob:stub';
  globalThis.URL.revokeObjectURL = () => {};
  return made;
}

const RESULT = {
  timestamp: '2026-10-01T12:34:56.000Z',
  score: 82.5,
  tier: 'A',
  zones: {
    mouth: { asymmetry: 0.02, percent: 3.2 },
    eyelid: { asymmetry: 0.03, percent: 8.1 },
    nasolabial: { asymmetry: 0.01, percent: 0 },
    forehead: { asymmetry: 0.04, percent: 12.5 },
  },
  fusion: { cnnUsed: true, cnnRole: 'cross-check', gap: 9.4 },
  cnnScore: 73.1,
  report: { blocks: [{ kind: 'conclusion', text: '这次看起来没什么问题，继续保持就好。' }] },
  modelVersions: { geo: 'geo-v1.0', cnn: 'cnn-v1.0', fusion: 'fusion-1.0', copy: null },
};

test('the report image draws no image content at all', async () => {
  const made = installDomStub();
  const { renderReportCanvas } = await import('../src/core/reportImage.js');
  renderReportCanvas(RESULT, { appVersion: 'v1.0-prototype', thresholdsApproved: false });
  assert.equal(made.length, 1, 'expected exactly one canvas');
  const calls = made[0];
  const draws = calls.filter((c) => c[0] === 'drawImage');
  assert.deepEqual(draws, [], 'the report must never draw an image (no face pixels)');
});

test('the report carries the score, the tier label and the disclaimer', async () => {
  const made = installDomStub();
  const { renderReportCanvas } = await import('../src/core/reportImage.js');
  renderReportCanvas(RESULT, { appVersion: 'v1.0-prototype', thresholdsApproved: false });
  const texts = made[0].filter((c) => c[0] === 'fillText').map((c) => c[1]).join(' ');
  assert.match(texts, /82\.5/, 'score must appear');
  assert.match(texts, /未见明显异常/, 'tier label must appear');
  assert.match(texts, /不是医疗器械/, 'disclaimer must appear');
  assert.match(texts, /不含照片/, 'the no-photo statement must appear');
  assert.match(texts, /面瘫/, 'differential reminder must appear');
});

test('the report carries NO developer-facing text', async () => {
  const made = installDomStub();
  const { renderReportCanvas } = await import('../src/core/reportImage.js');
  renderReportCanvas(RESULT, { appVersion: 'v1.0-prototype', thresholdsApproved: false });
  const texts = made[0].filter((c) => c[0] === 'fillText').map((c) => c[1]).join(' ');
  // users are not developers: no ticket ids, no config chatter, no internal docs
  for (const forbidden of [/T-\d\d/, /接力板/, /facestroke-build/, /临时值/, /未确认/, /开发中/]) {
    assert.ok(!forbidden.test(texts), `report image leaks developer text: ${forbidden}`);
  }
});

test('a cross-check CNN channel is described honestly, not as a scored channel', async () => {
  const made = installDomStub();
  const { renderReportCanvas } = await import('../src/core/reportImage.js');
  renderReportCanvas(RESULT, {});
  const texts = made[0].filter((c) => c[0] === 'fillText').map((c) => c[1]).join(' ');
  assert.match(texts, /交叉校验/);
  assert.match(texts, /不参与最终分数/);
});

test('a missing result degrades gracefully instead of throwing', async () => {
  const made = installDomStub();
  const { renderReportCanvas } = await import('../src/core/reportImage.js');
  assert.doesNotThrow(() => renderReportCanvas({
    timestamp: '', score: 0, tier: null, zones: null, report: null, modelVersions: null,
  }, {}));
  const texts = made[0].filter((c) => c[0] === 'fillText').map((c) => c[1]).join(' ');
  assert.match(texts, /未分档/);
});

test('shareReport falls back to a download when the Web Share API is absent', async () => {
  installDomStub();
  delete globalThis.navigator;
  globalThis.navigator = {};
  const { shareReport } = await import('../src/core/reportImage.js');
  const outcome = await shareReport(RESULT, {});
  assert.equal(outcome, 'downloaded');
});

test('shareReport reports cancellation rather than an error', async () => {
  installDomStub();
  globalThis.File = class File {
    constructor(parts, name, opts) { this.name = name; this.type = opts?.type; }
  };
  globalThis.navigator = {
    canShare: () => true,
    share: () => Promise.reject(Object.assign(new Error('abort'), { name: 'AbortError' })),
  };
  const { shareReport } = await import('../src/core/reportImage.js');
  assert.equal(await shareReport(RESULT, {}), 'cancelled');
});
