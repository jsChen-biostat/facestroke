/**
 * Unit tests for the health knowledge module (web/src/core/knowledge.js).
 *
 * Two behaviours matter here and are easy to get wrong:
 *   - the explainer must be DIFFERENT on every capture and must not repeat until
 *     the bank is exhausted (the user asked for exactly that)
 *   - the trend reading must describe the readings, never a medical risk level
 *
 * Run: cd web && npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FACTS, ADVICE, SOURCES, ZONE_INFO, zoneBranch,
  pickDailyFact, pickAdviceBatch, interpretTrend, TREND_LIMITATION,
} from '../src/core/knowledge.js';

/* --------------------------------------------------------------- rotation */

test('the explainer rotates and does not repeat until the bank is exhausted', () => {
  const seen = [];
  for (let i = 0; i < FACTS.length; i += 1) seen.push(pickDailyFact().id);
  assert.equal(new Set(seen).size, FACTS.length,
    'every explainer must be shown once before any repeats');
  // and it keeps going
  const next = pickDailyFact();
  assert.ok(FACTS.some((f) => f.id === next.id), 'the cycle must continue');
});

test('consecutive captures never show the same explainer', () => {
  const a = pickDailyFact();
  const b = pickDailyFact();
  assert.notEqual(a.id, b.id, 'two captures in a row must differ');
  assert.ok(FACTS.length > 1, 'the bank needs more than one item to rotate');
});

test('every explainer is a title plus a real body and a source', () => {
  for (const f of FACTS) {
    assert.ok(f.title && f.title.length <= 16, `${f.id} needs a short title`);
    assert.ok(f.body && f.body.length >= 40, `${f.id} body is too thin to be useful`);
    assert.match(f.source, /^\[.+\]$/, `${f.id} must cite a source`);
  }
});

/* ------------------------------------------------------------ zone branches */

test('a zone branch reports the reading, never a diagnosis', () => {
  for (const zone of Object.keys(ZONE_INFO)) {
    for (const pct of [null, 0, 2.9, 3, 9.9, 10, 50]) {
      const b = zoneBranch(zone, pct);
      assert.ok(b.label && b.muscle && b.what, `${zone} needs label/muscle/what`);
      assert.ok(!/面瘫|卒中|中风|疾病|异常$/.test(b.verdict),
        `${zone} verdict must not name a disease: ${b.verdict}`);
    }
  }
});

test('zone branch bands follow the project-wide 3 / 10 thresholds', () => {
  assert.equal(zoneBranch('mouth', 2.9).tone, 'ok');
  assert.equal(zoneBranch('mouth', 3).tone, 'mild');
  assert.equal(zoneBranch('mouth', 9.9).tone, 'mild');
  assert.equal(zoneBranch('mouth', 10).tone, 'marked');
  assert.equal(zoneBranch('mouth', null).tone, 'unknown');
});

/* ----------------------------------------------------------- trend reading */

test('an empty history is not read as anything', () => {
  const r = interpretTrend({ n: 0 });
  assert.match(r.headline, /还没有/);
  assert.equal(r.escalate, false);
});

test('a single record is reported as too little to read', () => {
  const r = interpretTrend({ n: 1, latest: 62 });
  assert.match(r.headline, /记录还太少/);
  assert.equal(r.escalate, false);
});

test('each trend direction produces its own reading', () => {
  const cases = [
    ['improving', { n: 4, latest: 70, delta: 6, spread: 8 }],
    ['stable', { n: 4, latest: 66, delta: 1, spread: 4 }],
    ['worsening', { n: 4, latest: 52, delta: -8, spread: 12 }],
    ['volatile', { n: 4, latest: 60, delta: 4, spread: 30 }],
  ];
  const headlines = new Set();
  for (const [direction, summary] of cases) {
    const r = interpretTrend({ direction, ...summary });
    assert.ok(r.headline && r.detail && r.care && r.repeat, `${direction} needs full copy`);
    headlines.add(r.headline);
  }
  assert.equal(headlines.size, cases.length, 'directions must not share a headline');
});

test('only a downward trend escalates', () => {
  assert.equal(interpretTrend({ direction: 'worsening', n: 3, latest: 40, delta: -9, spread: 10 }).escalate, true);
  for (const direction of ['improving', 'stable', 'volatile']) {
    assert.equal(interpretTrend({ direction, n: 3, latest: 70, delta: 2, spread: 6 }).escalate, false);
  }
});

test('the trend reading never presents itself as a risk score', () => {
  assert.match(TREND_LIMITATION, /不是医学风险评估/);
  const r = interpretTrend({ direction: 'stable', n: 3, latest: 70, delta: 0, spread: 2 });
  const all = `${r.headline}${r.detail}${r.care}${r.repeat}`;
  assert.ok(!/风险(低|高|等级)/.test(all), 'it must not grade medical risk');
});

/* ------------------------------------------------------------------ advice */

test('everyday advice is actionable, sourced and free of drug instructions', () => {
  assert.ok(ADVICE.length >= 8, 'there must be real advice to show');
  for (const a of ADVICE) {
    const text = `${a.title}${a.body}`;
    assert.match(a.source, /^\[.+\]$/, `${a.id} must cite a source`);
    assert.ok(a.title && a.body, `${a.id} needs a title and a body`);
    // no numeric doses and no drug names anywhere
    assert.ok(!/\d+\s*(mg|毫克|克|片|粒|单位|国际单位)/i.test(text),
      `${a.id} must not carry a dose: ${text}`);
    assert.ok(!/阿司匹林|他汀|华法林|氯吡格雷|硝苯地平|氨氯地平/.test(text),
      `${a.id} must not name a drug: ${text}`);
  }
  // medication may only ever be framed as "follow the doctor"
  const med = ADVICE.find((a) => /用药/.test(a.title));
  assert.ok(med && /遵医嘱|按医嘱/.test(med.body), 'medication advice must defer to the doctor');
  // "stop taking" may only appear as "do not stop on your own"
  for (const a of ADVICE.filter((x) => /停药/.test(x.body))) {
    assert.match(a.body, /不要自行停药/, `${a.id} must not tell the user to stop medication`);
  }
  // the emergency instruction must be present somewhere
  assert.ok(ADVICE.some((a) => /120/.test(a.body)), 'the 120 instruction must be included');
});

test('advice rotates so the result screen stays short', () => {
  const a = pickAdviceBatch(4);
  const b = pickAdviceBatch(4);
  assert.equal(a.length, 4);
  assert.notDeepEqual(a.map((x) => x.id), b.map((x) => x.id), 'the slice must move on');
  for (const item of a) assert.ok(item.title && item.body);
});

/* ----------------------------------------------------------------- sources */

test('every source tag used is a real, registered source', () => {
  const tags = new Set(SOURCES.map((s) => s.tag));
  assert.ok(tags.size >= 5, 'there must be a real source list');
  for (const s of SOURCES) {
    assert.match(s.url, /^https?:\/\//, `${s.tag} needs a URL`);
    assert.ok(s.title, `${s.tag} needs a title`);
  }
  const used = new Set([...FACTS, ...ADVICE].map((i) => i.source));
  for (const tag of used) {
    assert.ok(tags.has(tag), `${tag} is cited but not registered in SOURCES`);
  }
  for (const tag of tags) {
    assert.ok(used.has(tag), `${tag} is registered but never cited`);
  }
});
