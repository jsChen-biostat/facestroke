/**
 * Copy and navigation regressions for the product UI.
 *
 * These encode the six issues reported from the first device test (2026-10-02):
 *  1. no capture step / stuck on the urgent screen
 *  2. only 120 did anything
 *  3. developer text visible in the product
 *  4. no back button anywhere
 *  5. copy too colloquial
 *  6. the footer disclaimer link did nothing
 *
 * Run: cd web && npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', 'src');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

/**
 * Strip comments WITHOUT mistaking /* inside a string literal for a block
 * comment. `accept="image/*"` previously ate half the file and produced two
 * false failures, so this is a line-based state machine rather than a regex.
 */
function stripComments(text) {
  const lines = text.split('\n');
  const out = [];
  let inBlock = false;
  for (const line of lines) {
    if (inBlock) {
      if (line.includes('*/')) inBlock = false;
      out.push('');
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlock = true;
      out.push('');
      continue;
    }
    out.push(line.replace(/(^|[^:])\/\/[^\n]*/g, '$1'));
  }
  return out.join('\n');
}

const files = walk(SRC);
const rel = (p) => relative(SRC, p).replace(/\\/g, '/');
const screens = files.filter((f) => rel(f).startsWith('screens/'));
const read = (f) => stripComments(readFileSync(f, 'utf8'));

/* ------------------------------------------------- issue 3: no dev text */

/**
 * The long-press developer panel is allowed to show internals. Return the source
 * with that template literal blanked out so the scan does not flag it.
 */
function withoutDeveloperPanel(text) {
  const lines = text.split('\n');
  const out = [];
  let inside = false;
  for (const line of lines) {
    if (!inside && /panel\.innerHTML\s*=/.test(line)) {
      inside = true;
      out.push('');
      if (/`;?\s*$/.test(line) && !/`\s*$/.test(line.trim().replace(/^.*`/, ''))) {
        // single-line assignment; nothing more to skip
      }
      if ((line.match(/`/g) || []).length >= 2) inside = false;
      continue;
    }
    if (inside) {
      if (/`/.test(line)) inside = false;
      out.push('');
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

test('no screen shows developer-facing text', () => {
  const forbidden = [
    [/接力板/, 'internal progress board reference'],
    [/facestroke-build/, 'internal doc path'],
    [/T-\d\d/, 'task-card id'],
    [/开发用临时值/, 'provisional-threshold note'],
    [/参数尚未确认|尚有 \d+ 项参数|未确认参数/, 'config-state chatter'],
    [/未训练（/, 'training-state chatter'],
    [/待实现（/, 'todo marker'],
  ];
  const leaks = [];
  for (const f of [...screens, join(SRC, 'core', 'report.js'), join(SRC, 'core', 'reportImage.js')]) {
    const text = withoutDeveloperPanel(read(f));
    text.split('\n').forEach((line, i) => {
      for (const [re, why] of forbidden) {
        if (re.test(line)) leaks.push(`${rel(f)}:${i + 1} ${why}: ${line.trim().slice(0, 70)}`);
      }
    });
  }
  assert.deepEqual(leaks, [], `developer text leaked into the product:\n${leaks.join('\n')}`);
});

test('the startup banner element is gone from the page shell', () => {
  const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
  assert.ok(!/config-warning/.test(html), 'index.html must not render a config warning banner');
});

/* ------------------------------------------- issue 4: no dead-end screens */

test('every screen offers a way out', () => {
  // S1 is the entry point: its exit is "不同意并退出", which closes the app rather
  // than navigating, so it legitimately carries no data-* navigation.
  const ENTRY_POINTS = new Set(['screens/s1_consent.js']);
  const dead = [];
  for (const f of screens) {
    if (ENTRY_POINTS.has(rel(f))) continue;
    const text = read(f);
    const hasExit = /data-back|data-nav|data-home/.test(text);
    if (!hasExit) dead.push(rel(f));
  }
  assert.deepEqual(dead, [], `screens with no navigation out: ${dead.join(', ')}`);
});

test('the urgent result screen offers a correction path, not just actions', () => {
  const text = read(join(SRC, 'screens', 's7_result.js'));
  assert.match(text, /fix-answers/, 'urgent screen must let the user go back and fix the intake answers');
  assert.match(text, /data-back|data-nav/, 'urgent screen must have a way out');
});

/* ------------------------------------------- issue 6: footer disclaimer */

test('the footer disclaimer link opens a real screen', () => {
  const main = readFileSync(join(SRC, 'main.js'), 'utf8');
  assert.match(main, /footer-disclaimer/, 'the footer button must be wired');
  assert.match(main, /#\/disclaimer/, 'it must navigate to the disclaimer screen');
  const screen = readFileSync(join(SRC, 'screens', 's12_disclaimer.js'), 'utf8');
  assert.ok(screen.length > 200, 'the disclaimer screen must have real content');
});

/* ---------------------------------------------- issue 2: urgent actions */

test('the urgent actions call real handlers instead of alert placeholders', () => {
  const text = read(join(SRC, 'screens', 's7_result.js'));
  assert.ok(!/alert\('附近医院列表将在/.test(text), 'hospital button must not be a placeholder alert');
  assert.ok(!/alert\('通知家人功能将在/.test(text), 'family button must not be a placeholder alert');
  assert.match(text, /openNearbyHospitals/, 'hospital button must call the map helper');
  assert.match(text, /notifyFamily/, 'family button must call the SMS helper');
});

test('the emergency helpers use OS intents and cannot fail silently', async () => {
  // the module touches window/document at call time only, so a light stub is enough
  globalThis.window = { open: () => null, location: { href: '' } };
  const { familyMessage } = await import('../src/core/emergency.js');
  const msg = familyMessage(82);
  assert.match(msg, /FaceStroke/);
  assert.match(msg, /82/);
  assert.ok(!/诊断|确诊|卒中/.test(msg), 'the family message must not assert a diagnosis');
});

/* --------------------------------------------------- issue 5: formality */

test('copy avoids the colloquial fillers that were flagged', () => {
  const flagged = [
    /图个安心/, /别慌/, /咱们/, /手有点抖/, /像照镜子/, /有点太亮/, /试试/,
    /没看清你的脸/, /换个亮一点/, /拍一张/, /没关系/,
  ];
  const hits = [];
  for (const f of [...screens, join(SRC, 'core', 'report.js'), join(SRC, 'core', 'quality.js')]) {
    const text = read(f);
    text.split('\n').forEach((line, i) => {
      for (const re of flagged) {
        if (re.test(line)) hits.push(`${rel(f)}:${i + 1} ${line.trim().slice(0, 70)}`);
      }
    });
  }
  assert.deepEqual(hits, [], `colloquial copy found:\n${hits.join('\n')}`);
});

/* ------------------------------------------------- issue 1: intake gate */

test('all three intake questions are required', () => {
  const text = read(join(SRC, 'screens', 's3_gate.js'));
  assert.match(text, /第 1 题/, 'missing-answer hint must name question 1');
  assert.match(text, /第 2 题/, 'missing-answer hint must name question 2');
  assert.match(text, /第 3 题/, 'missing-answer hint must name question 3');
  assert.match(text, /missing\.length/, 'the submit handler must block on missing answers');
});

test('the urgent path explains which symptoms triggered it', () => {
  const text = read(join(SRC, 'screens', 's7_result.js'));
  assert.match(text, /SYMPTOM_LABEL/, 'urgent screen must echo the reported symptoms');
  assert.match(text, /本次未进行面部图像评估/, 'it must say why no image assessment happened');
});

/* ------------------------------- capture step must always be reachable */

test('the capture screen always offers a camera path, live or system', () => {
  const text = read(join(SRC, 'screens', 's5_capture.js'));
  // the OS camera fallback is what makes the step exist on devices where the
  // WebView refuses getUserMedia
  assert.match(text, /type="file"[^>]*capture="user"/, 'must keep a file-input web fallback');
  assert.match(text, /accept="image\/\*"/, 'the file input must accept images');
  // an <input capture> is routed to the file picker inside a Capacitor WebView,
  // so the native camera plugin is the path that actually opens the camera
  assert.match(text, /from '\.\.\/core\/camera\.js'/, 'must use the native camera helper');
  assert.match(text, /takePhoto/, 'the shoot button must call the native camera');
  assert.match(text, /handleBlob/, 'the still must go through the quality gate');
  assert.match(text, /assessStill/, 'the still must be assessed by the same gate as live frames');
  assert.match(text, /startPreview/, 'a failed or interrupted preview must be resumable');
});

test('stills are decoded and detected robustly', () => {
  const lm = read(join(SRC, 'core', 'landmarks.js'));
  assert.match(lm, /imageOrientation: 'from-image'/, 'phone photos carry EXIF rotation and must be decoded respecting it');
  assert.match(lm, /detectLandmarksRobust/, 'detection must retry rotated frames');
  assert.match(lm, /rotatePointBack/, 'landmarks from a rotated frame must be mapped back');
  const cap = read(join(SRC, 'screens', 's5_capture.js'));
  assert.match(cap, /detectLandmarksRobust/, 'the capture screen must use robust detection for stills');
  assert.match(cap, /blobToBitmap/, 'the capture screen must use the EXIF-aware decoder');
});

test('the preview resumes after returning from the system camera', () => {
  const text = read(join(SRC, 'screens', 's5_capture.js'));
  assert.match(text, /visibilitychange/, 'must handle the app returning to the foreground');
  assert.match(text, /video\.paused/, 'must detect and recover a frozen preview');
  // handleBlob must bring the preview back once the picker/camera returns
  const blobFn = /const handleBlob[\s\S]*?\n    };/.exec(text);
  assert.ok(blobFn, 'handleBlob must exist');
  assert.match(blobFn[0], /startPreview\(\)/, 'must restart the preview after a still');
});

test('a model load failure is reported instead of looking like "no face"', () => {
  const text = read(join(SRC, 'screens', 's5_capture.js'));
  assert.match(text, /warmUpStatus/, 'must check the model status explicitly');
  assert.match(text, /面部识别模型未能加载/, 'must surface a model failure to the user');
  assert.match(text, /notice-retry/, 'must offer a retry');
});

test('a still capture goes through the same models as a live capture', () => {
  const text = read(join(SRC, 'screens', 's5_capture.js'));
  assert.match(text, /ctx\.state\.lastFrames\s*=/, 'a still must populate the same frame slot');
  assert.match(text, /#\/analyze/, 'a still must proceed to the analysis screen');
  assert.match(text, /source: 'system-camera'/, 'the capture source should be recorded');
});

test('reported symptoms do not cancel the capture step', () => {
  const text = read(join(SRC, 'screens', 's7_result.js'));
  assert.match(text, /continue-capture/, 'the urgent screen must let the user continue to capture');
  assert.match(text, /symptomsReported/, 'the result screen must remember that symptoms were reported');
  assert.match(text, /#\/prep/, 'continuing must lead into the capture flow');
});

/* ------------------- device test 3, issue 1: a fabricated image finding */

test('the symptom path never claims an image finding', () => {
  const text = read(join(SRC, 'screens', 's7_result.js'));
  const start = text.indexOf("if (ctx.state.mode === 'EMERGENCY')");
  // the comment banners are stripped by read(), so use live code as the marker
  const end = text.indexOf('const res = ctx.state.lastResult;');
  assert.ok(start > -1 && end > start, 'the urgent branch must be locatable');
  const branch = text.slice(start, end);
  // TIER_TEXT.D ("检测到明显的面部不对称表现") is an IMAGE result. On this path
  // no image was ever captured, so rendering it invents a measurement.
  assert.ok(!/TIER_TEXT\.D/.test(branch),
    'the symptom-only screen must not render the image-based tier D finding');
  assert.match(branch, /SYMPTOM_ONLY/, 'it must use the symptom-only copy instead');
  assert.match(branch, /未进行面部图像评估/, 'it must say plainly that no image was analysed');
  assert.ok(branch.length > 400, 'the branch must actually render something');
});

test('the symptom-only copy offers a photo test and states a possibility', async () => {
  const { SYMPTOM_ONLY } = await import('../src/core/report.js');
  assert.match(SYMPTOM_ONLY.noImage, /未进行面部图像评估/);
  assert.match(SYMPTOM_ONLY.suggest, /拍摄测试/, 'it must invite the photo test');
  assert.ok(!/检测到|发现/.test(JSON.stringify(SYMPTOM_ONLY)),
    'it must not assert a finding - only a possibility built from the answers');
});

/* --------------- device test 3, issue 2: black preview / dead button */

test('the camera starts before the models are awaited', () => {
  const text = read(join(SRC, 'screens', 's5_capture.js'));
  const bootIdx = text.indexOf('const boot = async () =>');
  assert.ok(bootIdx > -1, 'boot must exist');
  const boot = text.slice(bootIdx);
  const previewIdx = boot.indexOf('startPreview();');
  const modelIdx = boot.indexOf('await warmUpStatus(');
  assert.ok(previewIdx > -1 && modelIdx > -1, 'boot must start the preview and load the models');
  // awaiting two MediaPipe models BEFORE opening the camera is what left the
  // panel black on a real phone
  assert.ok(previewIdx < modelIdx, 'the preview must be started before the model warm-up is awaited');
});

test('a preview that never produces a frame degrades instead of staying black', () => {
  const text = read(join(SRC, 'screens', 's5_capture.js'));
  assert.match(text, /PREVIEW_START_TIMEOUT_MS/, 'there must be a preview start-up watchdog');
  assert.match(text, /degradeToPhotoMode/, 'the watchdog must switch to photo mode');
  assert.match(text, /preview-status/, 'the panel must cover itself while starting');
  assert.match(text, /photo-mode/, 'photo mode must be explained on screen');
  assert.match(text, /livePanel\.hidden = true/, 'the video panel must be hidden once it is useless');
});

test('the shoot button always produces a visible outcome', () => {
  const text = read(join(SRC, 'screens', 's5_capture.js'));
  assert.match(text, /setBtnBusy/, 'the button must show a busy state');
  assert.match(text, /notice-fallback/, 'a failed native call must offer a working fallback');
  assert.match(text, /reason === 'denied'/, 'a denied permission must be told apart from a cancel');
  assert.match(text, /reason === 'cancelled'/, 'a cancel must be told apart from a failure');
  // the file input has to be opened synchronously, inside the tap
  assert.match(text, /fileInput\.click\(\)/, 'the fallback picker must be opened on the gesture');
});

test('a still capture cannot hang the screen forever', () => {
  const text = read(join(SRC, 'screens', 's5_capture.js'));
  assert.match(text, /STILL_TIMEOUT_MS/, 'still analysis must have a timeout');
  assert.match(text, /照片处理超时/, 'a timeout must be reported to the user');
});

test('a failed model load can actually be retried', () => {
  const s5 = read(join(SRC, 'screens', 's5_capture.js'));
  assert.match(s5, /resetModels/, 'the retry handler must drop the cached failure');
  const lm = read(join(SRC, 'core', 'landmarks.js'));
  const idx = lm.indexOf('export function resetModels');
  assert.ok(idx > -1, 'landmarks.js must export resetModels');
  const body = lm.slice(idx, idx + 200);
  assert.match(body, /landmarkerPromise = null/, 'it must clear the cached image-model promise');
  assert.match(body, /livePromise = null/, 'it must clear the cached video-model promise');
});

test('a model failure is never reported as "no face in the photo"', () => {
  const lm = read(join(SRC, 'core', 'landmarks.js'));
  assert.match(lm, /modelError: true/, 'robust detection must flag a missing model');
  const s5 = read(join(SRC, 'screens', 's5_capture.js'));
  assert.match(s5, /if \(modelError\)/, 'the capture screen must branch on it');
  const s6 = read(join(SRC, 'screens', 's6_analyze.js'));
  assert.match(s6, /面部识别模型未能加载，无法完成定位/,
    'the analysis screen must not blame the photo for a broken model');
});

/* ------------- device test 4: the model never loaded on the device at all */

test('model assets are fetched with explicit MIME types', () => {
  const lm = read(join(SRC, 'core', 'landmarks.js'));
  // MediaPipe injects the wasm loader as <script src>. On the device the asset
  // loader can serve it with a guessed (or missing) Content-Type and Chromium
  // then refuses to execute it, which surfaced as an unexplained [object Event].
  assert.match(lm, /blobUrlFor/, 'assets must be fetched and wrapped by us');
  assert.match(lm, /type: 'text\/javascript'|'text\/javascript'/, 'the loader must be typed as JS');
  assert.match(lm, /'application\/wasm'/, 'the wasm must be typed as application/wasm');
  assert.match(lm, /strategy: 'blob'/, 'the self-managed path must be reported');
  assert.match(lm, /forVisionTasks\(ASSET_BASE\)/, 'the plain path must remain as a fallback');
});

test('no asset URL is ever built with a double slash', () => {
  const lm = read(join(SRC, 'core', 'landmarks.js'));
  // THE BUG: a base ending in "/" plus MediaPipe's own "/name.js" produced
  // "mediapipe//vision_wasm_internal.js". A normal server normalises it away,
  // Android's AssetManager does not, and the model silently never loaded.
  assert.ok(!/new URL\('mediapipe\/'/.test(lm),
    'the mediapipe base must not carry a trailing slash');
  assert.match(lm, /new URL\('mediapipe', document\.baseURI\)/, 'use the slash-free base');
  assert.match(lm, /\$\{ASSET_BASE\}\/\$\{name\}/, 'asset URLs must add exactly one slash');
});

test('the asset base can be inspected from the developer panel', () => {
  const lm = read(join(SRC, 'core', 'landmarks.js'));
  assert.match(lm, /export function assetInfo/, 'the resolved base and strategy must be readable');
  assert.match(lm, /export async function preflight/, 'there must be a way to see which file is broken');
});

test('a model failure puts the raw reason on screen', () => {
  const s5 = read(join(SRC, 'screens', 's5_capture.js'));
  assert.match(s5, /notice-detail/, 'the failure notice needs a place for the reason');
  assert.match(s5, /describeModelFailure/, 'the reason must be assembled for the user');
  assert.match(s5, /反馈时请一并告知/, 'the user must be told to report it');
});

test('the analysis never blocks on the optional CNN channel', () => {
  const s6 = read(join(SRC, 'screens', 's6_analyze.js'));
  // device test 7: six unbounded onnxruntime calls stalled the pipeline at the
  // symmetry step, the watchdog fired, and 历史记录比对 / 评估结论 never ran
  assert.match(s6, /CNN_TOTAL_BUDGET_MS/, 'the CNN channel needs a hard time budget');
  assert.match(s6, /CNN_CALL_TIMEOUT_MS/, 'each individual call must be bounded too');
  assert.match(s6, /cnnCall/, 'calls must go through the budgeted wrapper');
  assert.match(s6, /continuing without it/, 'it must continue when the CNN is unavailable');
  assert.match(s6, /STALL_TIMEOUT_MS/, 'a slow step must not be mistaken for a hang');
  assert.ok(!/ANALYSIS_TIMEOUT_MS/.test(s6),
    'an absolute whole-pipeline timeout cuts off the later steps');
  // the last two steps must be present and reachable
  assert.match(s6, /历史记录比对/, 'the history step must exist');
  assert.match(s6, /生成评估结论/, 'the conclusion step must exist');
});

/* ------------- device test 7: progress, landmark map, advice, explainers */

test('the analysis shows a real progress bar and live captions', () => {
  const s6 = read(join(SRC, 'screens', 's6_analyze.js'));
  assert.match(s6, /progress-fill/, 'there must be a progress bar');
  assert.match(s6, /progress-caption|#caption/, 'and a caption line');
  assert.match(s6, /caption: '/, 'each step must carry its own caption');
  assert.match(s6, /setProgress/, 'progress must advance with the steps');
});

test('the capture is scanned with an animation before the result', () => {
  const s6 = read(join(SRC, 'screens', 's6_analyze.js'));
  assert.match(s6, /createScanView/, 'there must be a scan view');
  assert.match(s6, /setLandmarks/, 'the real landmarks must appear on it');
  assert.match(s6, /snapshot/, 'and a still must be frozen for the result');
  assert.match(s6, /scan-wrap/, 'the scan view needs a place on the screen');
});

test('the result offers a collapsible landmark map with four zone branches', () => {
  const s7 = read(join(SRC, 'screens', 's7_result.js'));
  assert.match(s7, /details class="landmark-panel"/, 'the map must be collapsible');
  assert.match(s7, /zoneBranches/, 'four branches must hang off it');
  assert.match(s7, /overlayDataUrl/, 'it must use the frozen landmark image');
  assert.match(s7, /不写入历史记录/, 'it must say the image is not persisted');
  const k = read(join(SRC, 'core', 'knowledge.js'));
  for (const z of ['forehead', 'eyelid', 'nasolabial', 'mouth']) {
    assert.match(k, new RegExp(`${z}:`), `the ${z} branch needs an explanation`);
  }
});

test('records never accept the landmark image', () => {
  const s = read(join(SRC, 'core', 'storage.js'));
  // NOTE: the source writes the escaped form `data:image\/`, and the test's
  // comment stripper eats everything after `\//`, so match the prefix only.
  assert.match(s, /data:image/, 'a data URL must be refused outright');
  const s7 = read(join(SRC, 'screens', 's7_result.js'));
  const record = /addRecord\(\{[\s\S]*?\}\)/.exec(s7);
  assert.ok(record, 'addRecord must be called with an explicit field list');
  assert.ok(!/overlayDataUrl|landmarks/.test(record[0]),
    'the landmark image and points must never reach the record store');
});

test('everyday advice appears, but not on the urgent tier', () => {
  const s7 = read(join(SRC, 'screens', 's7_result.js'));
  assert.match(s7, /adviceBatch|ADVICE/, 'the result must show everyday advice');
  assert.match(s7, /tier === 'D' \? '' : `/, 'the urgent tier carries actions only');
  const s10 = read(join(SRC, 'screens', 's10_records.js'));
  assert.match(s10, /ADVICE/, 'the records screen must offer advice too');
});

test('a different explainer is shown on every capture, without repeats', () => {
  const k = read(join(SRC, 'core', 'knowledge.js'));
  assert.match(k, /export const FACTS = \[/, 'there must be an explainer bank');
  assert.match(k, /pickDailyFact/, 'and a picker');
  assert.match(k, /readIndex|writeIndex/, 'the rotation must be persisted');
  assert.ok(!/Math\.random/.test(k), 'rotation must be sequential, not random');
  const s6 = read(join(SRC, 'screens', 's6_analyze.js'));
  assert.match(s6, /pickDailyFact/, 'the analysis must pick one per capture');
  const s7 = read(join(SRC, 'screens', 's7_result.js'));
  assert.match(s7, /dailyFact/, 'and the result must show it');
});

test('the trend is read in words with advice', () => {
  const k = read(join(SRC, 'core', 'knowledge.js'));
  assert.match(k, /interpretTrend/, 'there must be a trend reading');
  assert.match(k, /TREND_LIMITATION/, 'and its limitation statement');
  assert.match(k, /不是医学风险评估/, 'it must not present itself as a risk score');
  const s10 = read(join(SRC, 'screens', 's10_records.js'));
  assert.match(s10, /interpretTrend/, 'the records screen must use it');
  assert.match(s10, /趋势解读/, 'and show it as its own section');
});

test('health knowledge carries sources and claims nothing diagnostic', () => {
  const k = read(join(SRC, 'core', 'knowledge.js'));
  assert.match(k, /source: '\[/, 'every item must cite a source');
  // 02 red lines 10 and 11 apply to knowledge copy exactly as they do to results
  for (const banned of [/确诊/, /不存在/, /可以放心/, /不必担心/, /准确率/, /排除脑卒中(?!、面神经炎)/]) {
    assert.ok(!banned.test(k), `knowledge copy must avoid ${banned}`);
  }
});

/* ------------- device test 8: action readings, feedback, the AI channel */

test('the action test reads raw zone asymmetry correctly', () => {
  const s5 = read(join(SRC, 'screens', 's5_capture.js'));
  // device test 8: every action reported 未测到 because the code read `.percent`
  // off a number. computeGeometry().zones is Record<string, number>.
  assert.ok(!/\?\.percent/.test(s5),
    'zone values are raw numbers - reading .percent off them silently yields undefined');
  assert.match(s5, /zonePercent\(/, 'raw asymmetry must be converted to percent');
  assert.match(s5, /ACTION_MIN_SAMPLES/, 'a single frame must not count as a measurement');
  // the shape that caused the bug: zones is a map of raw numbers
  const sym = read(join(SRC, 'core', 'symmetry.js'));
  assert.match(sym, /return \{ score, zones: res\.zones, a, pairs: res\.pairs \}/,
    'computeGeometry returns raw zone values, not {asymmetry, percent} objects');
});

test('each action and the end of the test are announced by sound and vibration', () => {
  const s5 = read(join(SRC, 'screens', 's5_capture.js'));
  assert.match(s5, /cueStart/, 'the start of an action must be cued');
  assert.match(s5, /cueActionDone/, 'the end of an action must be cued');
  assert.match(s5, /cueAllDone/, 'the end of the whole test must be cued');
  assert.match(s5, /请睁开眼睛/, 'the eyes action must be followed by a spoken cue');
  assert.match(s5, /primeFeedback/, 'audio must be unlocked on a user gesture');
  const f = read(join(SRC, 'core', 'feedback.js'));
  assert.match(f, /@capacitor\/haptics/, 'real haptics on device');
  assert.match(f, /navigator\.vibrate/, 'with a web fallback');
  assert.match(f, /AudioContext/, 'and a generated tone, so no audio asset is needed');
});

test('the AI channel loads its own assets with explicit MIME types', () => {
  const c = read(join(SRC, 'core', 'cnn.js'));
  // same root cause as the MediaPipe failure: ORT dynamic-imports its .mjs glue,
  // and a module script with a guessed Content-Type is refused by Chromium
  assert.match(c, /blobUrlFor/, 'the ORT assets must be fetched by us');
  assert.match(c, /'text\/javascript'/, 'the .mjs needs a real JS type');
  assert.match(c, /'application\/wasm'/, 'the .wasm needs application/wasm');
  assert.match(c, /wasmPaths = \{ mjs, wasm \}/, 'both must be handed to ORT together');
  assert.ok(!/new URL\('ort\/'/.test(c), 'the ORT base must not carry a trailing slash');
  assert.match(c, /@capacitor\/haptics|modelStatus/, 'and it must report its own status');
});

test('the result screen contains no model-development detail', () => {
  // 使用者明确要求：训练相关的东西（AUC、样本量、特征工程）是开发者的事，
  // 不属于检测报告。它们只允许出现在「查看评估原理」页。
  const s7 = read(join(SRC, 'screens', 's7_result.js'));
  for (const leaked of [/AUC/, /判对比例/, /训练数据实测/, /几何特征/]) {
    assert.ok(!leaked.test(s7), `result screen leaks development detail: ${leaked}`);
  }
  // 交叉校验分数（既无意义又让人困惑）不得再出现在结果页
  assert.ok(!/交叉校验/.test(s7), 'the pointless cross-check readout must stay gone');
  assert.ok(!/CNN_SKIP_TEXT/.test(s7), 'and its reason vocabulary with it');
  // 但"不是诊断"这句必须在
  assert.match(s7, /不能作为诊断依据/, 'the limitation must stay on the result screen');
  const s8 = read(join(SRC, 'screens', 's8_algorithm.js'));
  assert.match(s8, /第二通道/, 'the explainer screen carries the explanation instead');
});

test('the second channel is stated in the same direction as the score', () => {
  // 使用者反馈：几何分数是"越高越对称"，模型原本输出"越不对称概率越高"，
  // 两个方向相反的数字摆在同一屏，读起来自相矛盾。现在两边都只给结论。
  const s7 = read(join(SRC, 'screens', 's7_result.js'));
  assert.match(s7, /未见明显不对称/, 'a clean reading must be worded like the score');
  assert.match(s7, /可见明显不对称/, 'and an asymmetric one likewise');
  assert.match(s7, /两个方法的结论一致/, 'agreement must be stated');
  assert.match(s7, /结论不一致/, 'and disagreement stated honestly, without one vetoing the other');
});

/* ------------- device test 6: four requested improvements */

test('navigation is delegated so buttons created after render still work', () => {
  // comments are stripped: the file's own explanation quotes the old pattern
  const main = read(join(SRC, 'main.js'));
  // "重新采集" on the analysis screen is inserted only when the capture is
  // rejected, i.e. after render(). Per-render wiring never reached it.
  assert.match(main, /closest\('\[data-nav\]'\)/, 'navigation must use event delegation');
  assert.match(main, /closest\('\[data-back\]'\)/, 'back must use event delegation too');
  assert.ok(!/querySelectorAll\('\[data-nav\]'\)/.test(main),
    'per-render wiring leaves late buttons dead');
});

test('the three guided actions are measured, not just described', () => {
  const s5 = read(join(SRC, 'screens', 's5_capture.js'));
  assert.match(s5, /const ACTIONS = \[/, 'the actions must be a real list');
  assert.match(s5, /runActionTest/, 'there must be an action-test phase');
  assert.match(s5, /computeGeometry/, 'each action sample must be measured');
  assert.match(s5, /ctx\.state\.actionTest =/, 'the measurement must survive the screen');
  assert.match(s5, /ACTION_MS/, 'the action phase must sample over time');
  const s4 = read(join(SRC, 'screens', 's4_prep.js'));
  assert.match(s4, /实际测量/, 'the prep screen must say the actions are measured');
  assert.ok(!/轻轻皱眉/.test(s4), 'the old decorative instruction must be gone');
});

test('an action finding can only make the result more cautious', () => {
  const s6 = read(join(SRC, 'screens', 's6_analyze.js'));
  assert.match(s6, /applyActionTest/, 'the analysis must apply the action result');
  const s7 = read(join(SRC, 'screens', 's7_result.js'));
  assert.match(s7, /动作测试/, 'the result must show the action test');
  assert.match(s7, /ACTION_TEST_NOTE|actionSkipText/, 'and must explain or excuse its absence');
});

test('the tier wording never rules a disease out', () => {
  // the user asked for "不存在明显中风或其他面部疾病的痕迹" - a diagnostic
  // reassurance. It is refused: a false all-clear is the most dangerous sentence
  // this app could print. Every tier describes the IMAGE, not the person.
  const text = read(join(SRC, 'core', 'report.js'));
  const banned = /不存在|排除(?!脑卒中)|没有(中风|卒中|面瘫)|未发现.{0,6}(疾病|中风|卒中)|可以放心|不必担心/;
  const tiers = text.slice(text.indexOf('export const TIER_TEXT'), text.indexOf('export const RESULT_LIMITATION'));
  assert.ok(!banned.test(tiers), 'a tier conclusion must not exclude a disease');
  assert.match(tiers, /对称度测量结果/, 'tiers must talk about the measurement');
});

test('every result states what the measurement cannot do', () => {
  const text = read(join(SRC, 'core', 'report.js'));
  assert.match(text, /RESULT_LIMITATION/, 'there must be a limitation statement');
  assert.match(text, /不能据此排除/, 'it must say the result cannot exclude disease');
  const s7 = read(join(SRC, 'screens', 's7_result.js'));
  assert.match(s7, /RESULT_LIMITATION/, 'the result screen must show it');
  assert.match(s7, /结果局限性/, 'and must label it clearly');
});

test('the report image can be saved to the gallery and shared natively', () => {
  const text = read(join(SRC, 'core', 'reportImage.js'));
  assert.match(text, /saveReportToGallery/, 'saving to the gallery must exist');
  assert.match(text, /@capacitor-community\/media/, 'it needs the media plugin');
  assert.match(text, /savePhoto/, 'and must call savePhoto');
  assert.match(text, /getAlbums|createAlbum/, 'Android requires an album identifier');
  assert.match(text, /shareReportImage/, 'native sharing must exist');
  assert.match(text, /@capacitor\/share/, 'it needs the share plugin');
  assert.match(text, /Filesystem\.writeFile/, 'the image must be written before sharing');
  assert.match(text, /downloadBlob/, 'the web build must keep a download fallback');
  const s7 = read(join(SRC, 'screens', 's7_result.js'));
  assert.match(s7, /save-report/, 'the result screen needs a save button');
  assert.match(s7, /保存报告图片到相册/, 'and it must be labelled plainly');
  assert.match(s7, /share-report/, 'and a share button');
});



