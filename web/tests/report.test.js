/**
 * Unit tests for the report builder and tier logic (web/src/core/report.js).
 *
 * These tests guard the compliance red lines:
 *  - the urgent tier text carries NO advice verb
 *  - generated copy contains no banned "AI-sounding" or over-claiming phrase
 *  - the tier is never produced when thresholds are missing
 *
 * Run: cd web && npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TIER_TEXT, TIER_LABEL, DISCLAIMER_SHORT, DIFFERENTIAL_REMINDER,
  buildReport, decideTier, zonePhrase, zonePercent,
  scanText, BANNED_PATTERNS, ADVICE_PATTERNS, COPY_VERSION,
} from '../src/core/report.js';

const TH = { aMin: 70, bMin: 50, cMin: 30, approved: false, ambiguousBand: 3 };

/* ------------------------------------------------------------------- tiers */

test('decideTier maps scores onto the four tiers', () => {
  assert.equal(decideTier(95, TH).tier, 'A');
  assert.equal(decideTier(70, TH).tier, 'A');
  assert.equal(decideTier(69, TH).tier, 'B');
  assert.equal(decideTier(50, TH).tier, 'B');
  assert.equal(decideTier(49, TH).tier, 'C');
  assert.equal(decideTier(30, TH).tier, 'C');
  assert.equal(decideTier(29, TH).tier, 'D');
  assert.equal(decideTier(0, TH).tier, 'D');
});

test('scores near a boundary are flagged ambiguous instead of being forced', () => {
  assert.equal(decideTier(70, TH).ambiguous, true);
  assert.equal(decideTier(72, TH).ambiguous, true);
  assert.equal(decideTier(74, TH).ambiguous, false);
  assert.equal(decideTier(106, TH).ambiguous, false);
});

test('no tier is produced when thresholds are missing or a score is invalid', () => {
  assert.equal(decideTier(80, { aMin: null, bMin: null, cMin: null }).tier, null);
  assert.equal(decideTier(80, null).tier, null);
  assert.equal(decideTier(Number.NaN, TH).tier, null);
  assert.equal(decideTier(80, {}).reason, 'thresholds_missing');
});

/* ------------------------------------------------------- compliance copy */

test('the urgent tier text contains no advice verb at all', () => {
  const hits = scanText(TIER_TEXT.D, ADVICE_PATTERNS);
  assert.deepEqual(hits, [], `urgent text must not advise, found: ${hits}`);
});

test('tier texts and labels avoid banned phrases', () => {
  for (const [k, v] of Object.entries(TIER_TEXT)) {
    assert.deepEqual(scanText(v, BANNED_PATTERNS), [], `TIER_TEXT.${k} contains a banned phrase`);
  }
  for (const [k, v] of Object.entries(TIER_LABEL)) {
    assert.deepEqual(scanText(v, BANNED_PATTERNS), [], `TIER_LABEL.${k} contains a banned phrase`);
  }
  assert.deepEqual(scanText(DISCLAIMER_SHORT, BANNED_PATTERNS), []);
  assert.deepEqual(scanText(DIFFERENTIAL_REMINDER, BANNED_PATTERNS), []);
});

test('the banned list actually catches over-claiming language', () => {
  assert.ok(scanText('本工具可以提前 2 年预警卒中', BANNED_PATTERNS).length > 0);
  assert.ok(scanText('模型准确率 99%', BANNED_PATTERNS).length > 0);
  assert.ok(scanText('首先，其次，总之', BANNED_PATTERNS).length >= 3);
  assert.deepEqual(scanText('这次看起来没什么问题，继续保持就好。', BANNED_PATTERNS), []);
});

/* --------------------------------------------------------------- phrases */

test('zonePercent maps calibration anchors onto 0-100%', () => {
  assert.equal(zonePercent(0.0542, 0.0542, 0.1896), 0);
  assert.equal(zonePercent(0.1896, 0.0542, 0.1896), 100);
  assert.equal(zonePercent(0.5, 0.0542, 0.1896), 100, 'above aMax clamps to 100');
  assert.equal(zonePercent(0.01, 0.0542, 0.1896), 0, 'below aRef clamps to 0');
  assert.equal(zonePercent(0.1219, 0.0542, 0.1896), 50);
  assert.equal(zonePercent(Number.NaN, 0.0542, 0.1896), null);
  assert.equal(zonePercent(0.1, 0.2, 0.1), null, 'degenerate anchors return null');
});

test('zone phrases pick the right band and stay short', () => {
  assert.match(zonePhrase('mouth', 15), /明显/);
  assert.match(zonePhrase('mouth', 5), /轻微差异/);
  assert.match(zonePhrase('mouth', 1), /基本对称/);
  assert.equal(zonePhrase('unknown_zone', 10), null);
  for (const z of ['mouth', 'eyelid', 'nasolabial', 'forehead']) {
    for (const p of [0, 5, 20]) {
      const s = zonePhrase(z, p);
      assert.ok(s && s.length <= 25, `${z}@${p} phrase too long: ${s}`);
      assert.ok(!s.includes('！'), 'copy must not use exclamation marks');
    }
  }
});

/* ---------------------------------------------------------------- report */

test('buildReport always carries the differential reminder and disclaimer', () => {
  const r = buildReport({ score: 88, zones: {}, tier: 'A', previousScore: null });
  assert.equal(r.version, COPY_VERSION);
  const kinds = r.blocks.map((b) => b.kind);
  assert.ok(kinds.includes('differential'));
  assert.ok(kinds.includes('disclaimer'));
  assert.ok(kinds.includes('conclusion'));
});

test('buildReport produces no banned phrase for any tier', () => {
  for (const tier of ['A', 'B', 'C', 'D']) {
    const r = buildReport({
      score: 40,
      zones: { mouth: { asymmetry: 0.2, percent: 30 }, eyelid: { asymmetry: 0.1, percent: 12 } },
      tier,
      previousScore: 45,
      hasCnn: true,
    });
    const all = r.blocks.map((b) => b.text).join(' ');
    assert.deepEqual(scanText(all, BANNED_PATTERNS), [], `tier ${tier} report contains a banned phrase`);
  }
});

test('buildReport handles a missing tier and missing CNN channel honestly', () => {
  const r = buildReport({ score: 55, zones: {}, tier: null, previousScore: null, hasCnn: false });
  const texts = r.blocks.map((b) => b.text).join(' ');
  assert.match(texts, /未得出分档结论/);
  assert.match(texts, /AI 通道本次未参与评估/);
  assert.match(texts, /首次记录/);
});

test('buildReport phrases the change versus the last record', () => {
  const base = { score: 60, zones: {}, tier: 'B', hasCnn: true };
  assert.match(buildReport({ ...base, previousScore: 50 }).blocks.find((b) => b.kind === 'change').text, /改善/);
  assert.match(buildReport({ ...base, previousScore: 70 }).blocks.find((b) => b.kind === 'change').text, /下降/);
  assert.match(buildReport({ ...base, previousScore: 61 }).blocks.find((b) => b.kind === 'change').text, /一致/);
});

test('an ambiguous result adds a caution and a single action line', () => {
  const r = buildReport({
    score: 70, zones: {}, tier: 'A', previousScore: null, ambiguous: true, hasCnn: true,
  });
  assert.ok(r.blocks.some((b) => b.kind === 'caution'));
  assert.ok(r.blocks.some((b) => b.kind === 'action' && /线下检查/.test(b.text)));
});

test('zone evidence is limited to the two most asymmetric zones', () => {
  const zones = {
    mouth: { percent: 30 },
    eyelid: { percent: 20 },
    nasolabial: { percent: 5 },
    forehead: { percent: 1 },
  };
  const r = buildReport({ score: 55, zones, tier: 'B', previousScore: null, hasCnn: true });
  const geo = r.blocks.filter((b) => b.kind === 'evidence_geo');
  assert.equal(geo.length, 2);
  assert.deepEqual(geo.map((g) => g.zone), ['mouth', 'eyelid']);
});
