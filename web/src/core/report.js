/**
 * Report generation: template + rule engine. NOT a language model.
 *
 * Spec: 06_ui_and_copy.md §4 ("this is how we keep the copy from sounding AI-written")
 *
 * Structure: 结论句 + 几何证据句 + AI 证据句 + 变化句 + 鉴别提醒 + 行动句 + 免责句
 * Every slot is filled from a fixed phrase bank by a rule. Nothing free-generates.
 *
 * WRITING RULES (enforced by tests in tests/report.test.js)
 *  - no LLM call anywhere in this file
 *  - banned connectives: 首先 其次 最后 总之 综上所述 值得注意的是 需要指出的是
 *    综上 一方面 另一方面 不仅 而且 让我们 本文 旨在 致力于 赋能 闭环
 *  - sentences <= 25 characters where practical
 *  - no exclamation marks
 *  - tier D carries a DESCRIPTION ONLY, with no advice verb anywhere
 */

export const COPY_VERSION = 'copy-v1.1';

export const ZONE_LABELS = {
  forehead: '额纹区',
  eyelid: '眼睑区',
  nasolabial: '鼻唇沟区',
  mouth: '口角区',
};

/**
 * Fixed conclusion per tier. 🔴-03: the final wording needs a doctor's sign-off.
 *
 * 2026-10-02: rewritten in a formal register (user feedback); the urgent tier
 * still carries NO advice verb - enforced by tests.
 *
 * 2026-10-02 (fifth round, user asked for more medical phrasing): the wording is
 * now written as a statement about the MEASUREMENT ("对称度测量结果…") rather
 * than about the person. That is deliberate and must stay that way.
 *
 * WHAT WE MUST NOT WRITE HERE: "不存在中风或其他面部疾病的痕迹". That is a
 * diagnostic reassurance - it rules disease out - and it violates red lines 2
 * and 3. A false reassurance is also the single most dangerous sentence this app
 * could produce, because it would talk someone out of calling 120. Every tier
 * therefore describes the image, and RESULT_LIMITATION states plainly that a
 * normal-looking image cannot exclude anything.
 */
export const TIER_TEXT = {
  A: '本次面部图像未见明显左右不对称，对称度测量结果位于参考范围内。',
  B: '本次面部图像可见轻度左右不对称，对称度测量结果略低于参考范围。',
  C: '本次面部图像可见左右不对称，对称度测量结果低于参考范围。',
  D: '检测到明显的面部不对称表现。',
};

/**
 * The sentence that must accompany any result, at every tier.
 *
 * This is what replaces the "no trace of stroke" reassurance the user asked for:
 * it says what the measurement is, and what it cannot do.
 */
export const RESULT_LIMITATION =
  '对称度测量只反映本次面部图像的左右差异，不能据此排除脑卒中、面神经炎或其他疾病。'
  + '如出现口角歪斜、言语不清或肢体无力，请立即就医或拨打 120。';

export const TIER_LABEL = {
  A: '未见明显异常',
  B: '建议观察',
  C: '建议就诊',
  D: '需要留意',
};

/**
 * Copy for the SYMPTOM-driven urgent screen, where NO image was ever analysed.
 *
 * WHY THIS EXISTS: when the user ticks a stroke symptom the intake gate sends
 * them straight to the urgent screen without any capture, and that screen used to
 * render TIER_TEXT.D - "检测到明显的面部不对称表现". That sentence is an IMAGE
 * FINDING. Showing it to someone who was never photographed is a fabricated
 * result; the third device test reported exactly this ("it says asymmetry was
 * detected but I never took a photo").
 *
 * So the symptom path gets its own honesty-preserving copy: a possibility
 * statement built from the user's own answers, an explicit note that no image was
 * analysed, and an invitation to run the photo test.
 */
export const SYMPTOM_ONLY = {
  headline: '需要优先就医',
  possibility: '上述症状与急性脑血管事件的表现相似，存在需要优先就医的情况。',
  noImage: '本次未进行面部图像评估：尚未拍摄面部照片，因此没有对称度结论。',
  suggest: '建议接下来做一次面部拍摄测试，它会给出客观的左右对称度数据，供您就医时参考。',
  suggestNote: '拍摄与计算均在本机完成，照片不会上传，也不保存原始照片。',
};

export const DISCLAIMER_SHORT = '本工具不是医疗器械，结果仅供参考，不能替代医生判断。';

export const DIFFERENTIAL_REMINDER =
  '面部不对称亦可由面神经炎（面瘫）、低血糖、癫痫发作后状态、偏头痛、牙科或眼部疾病等引起，建议就医以明确病因。';

/** Geometry evidence phrases per zone, chosen by the measured value. */
const ZONE_PHRASES = {
  mouth: [
    [10, '左右口角高度差较为明显。'],
    [3, '左右口角存在轻微差异。'],
    [0, '左右口角基本对称。'],
  ],
  eyelid: [
    [10, '双侧眼睑位置差异较为明显。'],
    [3, '双侧眼睑存在轻微差异。'],
    [0, '双侧眼睑基本对称。'],
  ],
  nasolabial: [
    [10, '双侧鼻唇沟深度差异较为明显。'],
    [3, '双侧鼻唇沟存在轻微差异。'],
    [0, '双侧鼻唇沟基本对称。'],
  ],
  forehead: [
    [10, '双侧额部纹路差异较为明显。'],
    [3, '双侧额部纹路存在轻微差异。'],
    [0, '双侧额部纹路基本对称。'],
  ],
};

const CHANGE_PHRASES = {
  better: '较上次有所改善。',
  worse: '较上次有所下降，建议继续观察。',
  same: '与上次基本一致。',
  first: '本次为首次记录。',
};

/** Values for the zone phrase thresholds are in "percent of face width" terms. */
const ZONE_THRESHOLDS = [10, 3, 0];

/**
 * The "较为明显" band (10%) that the static zone phrases already use. The guided
 * action test reuses it instead of inventing a second, unvalidated threshold.
 */
export const ZONE_NOTABLE_PERCENT = ZONE_THRESHOLDS[0];

export function isNotableZone(percent) {
  return Number.isFinite(percent) && percent >= ZONE_NOTABLE_PERCENT;
}

/**
 * The guided action test (device test 5: "the three action prompts are just text
 * and can be ignored").
 *
 * Until this revision S4 printed three instructions that nothing ever checked.
 * The capture screen now walks the user through them and MEASURES each one, so
 * the prompts have an actual effect on the result.
 *
 * 🔴 The action thresholds are provisional and are NOT in the tier decision
 * table: extra evidence may only ever make the app more cautious (see
 * policy.applyActionTest), never more reassuring.
 */
export const ACTION_LABELS = {
  brow: '抬起眉毛',
  smile: '露齿微笑',
  eyes: '用力闭眼',
};

export const ACTION_TEST_NOTE =
  '动作测试用于观察做表情时两侧变化是否对称，可补充静态图像的不足。该结果仅供参考。';

/** Why no action test happened. Said plainly instead of quietly omitting it. */
export function actionSkipText(reason) {
  switch (reason) {
    case 'still-path': return '本次使用手机相机直接拍摄单张照片，无法观察面部动作，因此未做动作测试。';
    case 'user-skip': return '本次已跳过动作测试，结果仅基于静态图像。';
    case 'no-face': return '动作测试阶段未能识别到面部，本次未完成动作测试。';
    default: return '本次未做动作测试，结果仅基于静态图像。';
  }
}

export function zonePhrase(zone, percent) {
  const bank = ZONE_PHRASES[zone];
  if (!bank) return null;
  for (let i = 0; i < bank.length; i += 1) {
    if (percent >= ZONE_THRESHOLDS[i]) return bank[i][1];
  }
  return bank[bank.length - 1][1];
}

/**
 * Convert a raw zone asymmetry (inter-ocular units) into a readable percentage.
 * Calibration: asymmetry of `aRef` reads as 0%, of `aMax` reads as 100%.
 */
export function zonePercent(asymmetry, aRef, aMax) {
  if (!Number.isFinite(asymmetry) || !Number.isFinite(aRef) || !Number.isFinite(aMax) || aMax <= aRef) {
    return null;
  }
  return Math.round(Math.max(0, Math.min(1, (asymmetry - aRef) / (aMax - aRef))) * 1000) / 10;
}

/**
 * Decide the tier.
 * @returns {{tier:'A'|'B'|'C'|'D'|null, ambiguous:boolean, reason:string}}
 */
export function decideTier(score, thresholds) {
  const t = thresholds || {};
  if (!Number.isFinite(score)) return { tier: null, ambiguous: false, reason: 'no_score' };
  const has = (v) => Number.isFinite(v);
  if (!has(t.aMin) || !has(t.bMin) || !has(t.cMin)) {
    return { tier: null, ambiguous: false, reason: 'thresholds_missing' };
  }
  const band = Number.isFinite(t.ambiguousBand) ? t.ambiguousBand : 0;
  const near = [t.aMin, t.bMin, t.cMin].some((b) => Math.abs(score - b) <= band);

  let tier;
  if (score >= t.aMin) tier = 'A';
  else if (score >= t.bMin) tier = 'B';
  else if (score >= t.cMin) tier = 'C';
  else tier = 'D';

  return { tier, ambiguous: near, reason: near ? 'ambiguous_band' : 'ok' };
}

/**
 * Assemble the report blocks.
 * @param {object} input
 * @param {number} input.score
 * @param {Record<string, {asymmetry:number, percent:number}>} input.zones
 * @param {'A'|'B'|'C'|'D'|null} input.tier
 * @param {number|null} input.previousScore
 * @param {boolean} input.ambiguous
 * @param {boolean} input.hasCnn whether the CNN channel contributed
 * @returns {{version:string, blocks:Array<{kind:string, text:string}>}}
 */
export function buildReport({
  score, zones, tier, previousScore = null, ambiguous = false, hasCnn = false, actionTest = null,
}) {
  const blocks = [];

  if (tier) {
    blocks.push({ kind: 'conclusion', text: TIER_TEXT[tier] });
  } else {
    blocks.push({ kind: 'conclusion', text: '本次未得出分档结论，请参考下方分项数据。' });
  }

  if (ambiguous) {
    blocks.push({ kind: 'caution', text: '本次分数接近分档边界，结果不够明确。' });
    blocks.push({ kind: 'action', text: '建议线下检查以进一步确认。' });
  }

  // geometry evidence: only mention the two most asymmetric zones, keep it short
  if (zones) {
    const ordered = Object.entries(zones)
      .filter(([z]) => ZONE_LABELS[z])
      .sort((a, b) => (b[1].percent ?? 0) - (a[1].percent ?? 0));
    for (const [zone, info] of ordered.slice(0, 2)) {
      if (info.percent === null || info.percent === undefined) continue;
      blocks.push({ kind: 'evidence_geo', zone, text: zonePhrase(zone, info.percent) });
    }
  }

  // guided action test: real measured values, one line per action
  if (actionTest && !actionTest.skipped && Array.isArray(actionTest.items)) {
    for (const item of actionTest.items) {
      if (!item || !Number.isFinite(item.percent)) continue;
      const action = ACTION_LABELS[item.key] || item.key;
      const zone = ZONE_LABELS[item.zone] || item.zone;
      const before = Number.isFinite(item.before) ? `（放松时 ${item.before}%）` : '';
      blocks.push({
        kind: 'evidence_action',
        action: item.key,
        text: `${action}时，${zone}不对称度为 ${item.percent}%${before}。`,
      });
    }
  }

  if (!hasCnn) {
    blocks.push({
      kind: 'evidence_cnn',
      text: 'AI 通道本次未参与评估。',
    });
  }

  if (previousScore === null || previousScore === undefined) {
    blocks.push({ kind: 'change', text: CHANGE_PHRASES.first });
  } else {
    const d = score - previousScore;
    if (d >= 3) blocks.push({ kind: 'change', text: CHANGE_PHRASES.better });
    else if (d <= -3) blocks.push({ kind: 'change', text: CHANGE_PHRASES.worse });
    else blocks.push({ kind: 'change', text: CHANGE_PHRASES.same });
  }

  blocks.push({ kind: 'differential', text: DIFFERENTIAL_REMINDER });
  blocks.push({ kind: 'disclaimer', text: DISCLAIMER_SHORT });

  return { version: COPY_VERSION, blocks };
}

/**
 * Sentences that must never appear in user-facing copy.
 *
 * NOTE on precision: bare /最后/ and /而且/ are NOT banned - they are ordinary
 * words ("就是最后这个分数" = "the final score"). What is banned is the AI-ish
 * DISCOURSE use, which in Chinese is marked by the following comma or by the
 * paired 不仅…而且 construction. The T-17 source scanner caught this and the
 * patterns were tightened rather than the copy being bent to fit a sloppy rule.
 */
export const BANNED_PATTERNS = [
  /首先[，,]/, /其次[，,]/, /最后[，,]/,
  /总之/, /综上所述/, /值得注意的是/, /需要指出的是/,
  /综上/, /一方面/, /另一方面/, /不仅[^。]{0,20}而且/, /让我们/, /本文/, /旨在/,
  /致力于/, /赋能/, /闭环/, /确诊/, /提前\s*\d+\s*年/, /准确率/,
];

/** Advice verbs that must NOT appear in the urgent tier's text. */
export const ADVICE_PATTERNS = [/建议/, /请/, /尽快/, /立即/, /应该/, /务必/];

export function scanText(text, patterns) {
  return patterns.filter((p) => p.test(text)).map((p) => p.source);
}
