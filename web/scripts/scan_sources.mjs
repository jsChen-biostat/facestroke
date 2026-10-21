/**
 * Static regression checks for the FaceStroke web app.
 *
 *   G2  no image data leaves the device  (source-level: every network call is
 *       allow-listed and same-origin, and none of them uploads a body)
 *   G5  no banned phrase appears in user-facing copy
 *
 * These complement the unit tests: the tests check behaviour, this checks that
 * nobody has quietly added an upload or an over-claiming sentence.
 *
 * Usage: cd web && node scripts/scan_sources.mjs [--json]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

import { BANNED_PATTERNS } from '../src/core/report.js';

const here = dirname(fileURLToPath(import.meta.url));
const WEB = join(here, '..');
const SRC = join(WEB, 'src');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk(SRC);
const rel = (p) => relative(WEB, p).replace(/\\/g, '/');

/**
 * Strip comments WITHOUT mistaking `/*` inside a string literal for a block
 * comment. `accept="image/*"` is the real case that broke the previous regex.
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

/* ------------------------------------------------------------------- G5 */

const SKIP_COPY_SCAN = new Set([
  'src/core/report.js',   // defines the patterns and the phrase banks
  'src/core/tts.js',      // speech helpers contain no user copy
]);

const copyTargets = [
  ...files.filter((f) => rel(f).startsWith('src/screens/')),
  ...files.filter((f) => ['src/core/report.js', 'src/core/policy.js', 'src/core/fusion.js', 'src/core/knowledge.js'].includes(rel(f))),
  join(WEB, 'index.html'),
].filter((f) => !SKIP_COPY_SCAN.has(rel(f)));

const g5 = [];
for (const f of copyTargets) {
  const raw = readFileSync(f, 'utf8');
  const text = f.endsWith('.html') ? stripComments(raw.replace(/<!--[\s\S]*?-->/g, '')) : stripComments(raw);
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const p of BANNED_PATTERNS) {
      if (p.test(line)) {
        g5.push({ file: rel(f), line: i + 1, pattern: p.source, text: line.trim().slice(0, 90) });
      }
    }
  });
}

/* ------------------------------------------------------------------- G2 */

const NET_ALLOWLIST = [
  // The ONLY network calls in the app: same-origin reads of static local model
  // files. None of them sends a body, and none of them can carry image data.
  { file: 'src/core/cnn.js', needle: 'fetch(`${ASSET_BASE}/models.json`' },
  // cnn.js also fetches the ORT glue/wasm itself for the same MIME reason
  { file: 'src/core/cnn.js', needle: 'const res = await fetch(url, { cache:' },
  // landmarks.js reads the MediaPipe assets with fetch() itself so it can attach
  // an explicit MIME type - see the header comment in that file for why.
  { file: 'src/core/landmarks.js', needle: 'const res = await fetch(url, { cache:' },
  { file: 'src/core/landmarks.js', needle: 'const res = await fetch(`${ASSET_BASE}/${name}`' },
  // asymmetryModel.js reads its own 45 KB same-origin JSON weights. No body, no
  // image data: the input to that model is landmark geometry, not pixels.
  { file: 'src/core/asymmetryModel.js', needle: 'fetch(MODEL_URL, { cache:' },
  { file: 'src/core/strokeEnsemble.js', needle: 'ensemble.json' },
];

/**
 * Same-origin proof for the allow-listed files. `new URL(x, document.baseURI)`
 * cannot point anywhere but our own origin, so a fetch built from it cannot
 * upload anything. If someone swaps in a literal remote URL this fails.
 */
const SAME_ORIGIN_PROOF = {
  'src/core/cnn.js': /const ASSET_BASE = new URL\([^)]*document\.baseURI/,
  'src/core/landmarks.js': /const ASSET_BASE = new URL\('mediapipe', document\.baseURI\)/,
  // the asymmetry model fetches its 45 KB weight file from our own origin
  'src/core/asymmetryModel.js': /const MODEL_URL = new URL\('models\/asymmetry_model\.json', document\.baseURI\)/,
  'src/core/strokeEnsemble.js': /models\/ensemble/,
};

const netHits = [];
const forbidden = [/XMLHttpRequest/, /sendBeacon/, /new WebSocket/, /EventSource/, /navigator\.geolocation/];
for (const f of files) {
  const text = stripComments(readFileSync(f, 'utf8'));
  const proof = SAME_ORIGIN_PROOF[rel(f)];
  text.split('\n').forEach((line, i) => {
    if (/\bfetch\s*\(/.test(line)) {
      const listed = NET_ALLOWLIST.some((a) => rel(f) === a.file && line.includes(a.needle));
      // a bare `fetch(` in a file with no same-origin base is never acceptable
      const sameOrigin = !!proof && proof.test(text);
      netHits.push({
        file: rel(f),
        line: i + 1,
        allowed: listed && sameOrigin,
        text: line.trim().slice(0, 100),
        reason: listed ? (sameOrigin ? null : 'same-origin proof missing') : 'not allow-listed',
      });
    }
    for (const p of forbidden) {
      if (p.test(line)) {
        netHits.push({ file: rel(f), line: i + 1, allowed: false, text: line.trim().slice(0, 100), reason: p.source });
      }
    }
  });
}
const g2Violations = netHits.filter((h) => !h.allowed);
const uploads = files.flatMap((f) => {
  const text = readFileSync(f, 'utf8');
  return /method:\s*['"]POST['"]/.test(text) ? [rel(f)] : [];
});

/* ------------------------------------------------------------------- G6 */

const css = readFileSync(join(SRC, 'styles', 'app.css'), 'utf8');
const g6 = [];
// the accessibility setting scales the ROOT font size, so text sizes must be
// rem-based. An absolute px font-size would silently ignore the setting.
for (const m of css.matchAll(/--fs-[a-z]+:\s*([^;]+);/g)) {
  if (!/rem/.test(m[1])) g6.push({ issue: 'font-size variable is not rem-based', value: m[0].trim() });
}
if (!/\[data-fontsize='large'\]/.test(css) || !/\[data-fontsize='xlarge'\]/.test(css)) {
  g6.push({ issue: 'missing one of the large/xlarge scale rules' });
}
if (!/html\s*\{[^}]*font-size:\s*calc\([^)]*var\(--scale\)/s.test(css)) {
  g6.push({ issue: 'root font-size does not use --scale' });
}
// touch targets: the primary button must stay large enough for shaky hands
const primaryBtn = css.match(/\.btn-primary\s*\{[\s\S]*?\}/);
if (!primaryBtn || !/min-height:\s*(6[4-9]|[7-9]\d|\d{3,})px/.test(primaryBtn[0])) {
  g6.push({ issue: 'primary button min-height below the 64px accessibility floor' });
}

/* ---------------------------------------------------------------- report */

const asJson = process.argv.includes('--json');
const result = {
  g2: { networkCalls: netHits.length, violations: g2Violations, uploads, pass: g2Violations.length === 0 && uploads.length === 0 },
  g5: { filesScanned: copyTargets.length, violations: g5, pass: g5.length === 0 },
  g6: { issues: g6, pass: g6.length === 0 },
};

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log('=== static regression checks ===');
  console.log(`scanned ${files.length} js files, ${copyTargets.length} copy-bearing files\n`);

  console.log('G2  image data never leaves the device');
  console.log(`    network calls found: ${netHits.length}`);
  for (const h of netHits) {
    console.log(`      ${h.allowed ? 'ALLOWED ' : 'REVIEW  '} ${h.file}:${h.line}  ${h.text}`);
  }
  console.log(`    POST bodies: ${uploads.length ? uploads.join(', ') : 'none'}`);
  console.log(`    -> ${result.g2.pass ? 'PASS' : 'FAIL'}\n`);

  console.log('G5  no banned phrase in user-facing copy');
  if (g5.length === 0) {
    console.log('    no violations');
  } else {
    for (const v of g5) console.log(`      ${v.file}:${v.line}  /${v.pattern}/  ${v.text}`);
  }
  console.log(`    -> ${result.g5.pass ? 'PASS' : 'FAIL'}\n`);

  console.log('G6  accessibility: text scaling actually works');
  if (g6.length === 0) {
    console.log('    font sizes are rem-based, scales present, primary button >= 64px');
  } else {
    for (const v of g6) console.log(`      ${v.issue}${v.value ? `: ${v.value}` : ''}`);
  }
  console.log(`    -> ${result.g6.pass ? 'PASS' : 'FAIL'} (200% visual walk-through still needs a human)`);
}

process.exit(result.g2.pass && result.g5.pass && result.g6.pass ? 0 : 1);
