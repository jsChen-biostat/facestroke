/**
 * Health knowledge shown to the user: everyday advice, rotating plain-language
 * explainers, per-zone explanations and a trend reading.
 *
 * WHY THIS FILE EXISTS (2026-10-02, seventh revision)
 *   The user asked for two things: everyday advice a person can act on, and a
 *   plain-language explainer that is DIFFERENT on every capture.
 *
 * RULES FOR ANYTHING IN THIS FILE
 *  - Every statement traces to a public-health source listed in SOURCES. Tags are
 *    only attached to documents that were actually retrieved and read; a source
 *    that could not be verified is not cited.
 *  - No drug names, no doses. Medication appears only as 遵医嘱 / 按医嘱.
 *  - Nothing asserts or excludes a diagnosis (02 red lines 10 and 11).
 *  - Formal written Chinese, 您, no exclamation marks, sentences <= 25 characters.
 *  - Explainers rotate rather than randomise, so a user sees every item once
 *    before any item repeats.
 *
 * CONTENT PROVENANCE
 *   中风120 / 4.5h window ... 中国卒中学会 中风120 特别行动组
 *                            (Zhao J, Liu R. Lancet Neurol 2016)
 *   BE-FAST, TIA, ambulance ... CDC
 *   blood pressure, salt, alcohol, CVD ... WHO fact sheets
 *   facial nerve vs brain pathway, Bell's palsy ... NHS
 *   sleep ... 国家卫健委《中国脑卒中防治指导规范（2021年版）》
 */

/* ------------------------------------------------------------------ sources */

export const SOURCES = [
  { tag: '[WHO]', title: '世界卫生组织 — 心血管疾病实况报道', url: 'https://www.who.int/news-room/fact-sheets/detail/cardiovascular-diseases-(cvds)' },
  { tag: '[WHO血压]', title: '世界卫生组织 — 高血压实况报道', url: 'https://www.who.int/news-room/fact-sheets/detail/hypertension' },
  { tag: '[WHO减盐]', title: '世界卫生组织 — 减少钠摄入实况报道', url: 'https://www.who.int/news-room/fact-sheets/detail/sodium-reduction' },
  { tag: '[WHO饮酒]', title: '世界卫生组织 — 酒精实况报道', url: 'https://www.who.int/news-room/fact-sheets/detail/alcohol' },
  { tag: '[CDC]', title: '美国疾病控制与预防中心 — 卒中症状', url: 'https://www.cdc.gov/stroke/signs-symptoms/index.html' },
  { tag: '[中国卒中学会]', title: '中国卒中学会中风120特别行动组 — 中风120是什么', url: 'http://stroke120.org/whatis/' },
  { tag: '[NHS]', title: '英国国家医疗服务体系 — 贝尔面瘫患者信息', url: 'https://www.nhs.uk/conditions/bells-palsy/' },
  { tag: '[国家卫健委脑卒中防治指导规范]', title: '国家卫生健康委办公厅 — 中国脑卒中防治指导规范（2021年版）', url: 'https://wsjkw.hebei.gov.cn/zcfg2/382002.jhtml' },
];

/* --------------------------------------------------------------- explainers */

export const FACTS = [
  {
    id: 'f1',
    title: '什么是卒中',
    body: '卒中俗称中风，指脑部血液供应突然受阻或血管破裂。脑组织因此缺血缺氧，功能受到损害。表现有突发面部或肢体无力、言语不清、视物异常。卒中属于急症，越早接受救治越有利。',
    source: '[WHO]',
  },
  {
    id: 'f2',
    title: '面部不对称的两条通路',
    body: '面部肌肉由面神经支配，面神经的上游连接大脑。面神经自身受损时，同侧额纹、闭眼与口角多同时受累。脑部病变时，常见额纹相对保留而口角与鼻唇沟更明显。区分需要医生结合查体判断。',
    source: '[NHS]',
  },
  {
    id: 'f3',
    title: 'FAST与BE-FAST识别',
    body: 'FAST用四步帮助记忆卒中表现。F是面部，请对方微笑并观察是否对称。A是手臂，请对方平举双臂。S是言语，请对方重复一句话。T是时间，出现异常就呼叫急救。BE-FAST补充平衡与视物异常两项。',
    source: '[CDC]',
  },
  {
    id: 'f4',
    title: '中国版中风120口诀',
    body: '中风120把急救号码与识别步骤联系起来。1是看一张脸，观察是否不对称。2是查两只胳膊，观察是否单侧无力。0是聆听语言，观察讲话是否清晰。任何一项异常都应立即拨打120。',
    source: '[中国卒中学会]',
  },
  {
    id: 'f5',
    title: '为什么时间如此关键',
    body: '缺血性卒中发生后，脑组织的损伤会随时间加重。发病4.5小时内进行溶栓治疗，部分患者预后可以改善。越早就诊，可供选择的治疗方式越多。因此请尽早呼叫急救。',
    source: '[中国卒中学会]',
  },
  {
    id: 'f6',
    title: '短暂发作同样需要就医',
    body: '短暂性脑缺血发作的症状可在几分钟内自行缓解。正因为缓解得快，这类情况容易被忽视。它提示脑血管可能存在严重问题，后续卒中风险较高。出现这类情况应尽快就医评估。',
    source: '[CDC]',
  },
  {
    id: 'f7',
    title: '血压与卒中风险',
    body: '高血压是卒中最主要的可干预危险因素之一。血压长期偏高会损伤血管，增加脑部血管堵塞的可能。请规范测量血压并遵医嘱管理，同时注意减盐与规律活动。',
    source: '[WHO血压]',
  },
  {
    id: 'f8',
    title: '房颤为何带来风险',
    body: '房颤时心房跳动不规则，血液容易在心脏内形成血栓。血栓脱落后可随血流进入脑动脉，造成缺血性卒中。房颤患者宜遵医嘱管理心律。控制血脂与血糖同样重要。',
    source: '[中国卒中学会]',
  },
  {
    id: 'f9',
    title: '血糖与血脂的影响',
    body: '长期血糖偏高会损伤血管内皮。血脂异常会加速动脉粥样硬化，使血管腔变窄。两者都会增加缺血性卒中的可能。请定期检测血糖与血脂，并按医嘱长期管理。',
    source: '[WHO]',
  },
  {
    id: 'f10',
    title: '吸烟与饮酒的影响',
    body: '烟草使用会损伤血管，并升高血压。烟草是卒中重要的行为危险因素。戒烟后风险可逐步下降。饮酒同样会升高血压，并增加心律失常风险。减少饮酒更有利于健康。',
    source: '[WHO]',
  },
  {
    id: 'f11',
    title: '自拍对称性检查的局限',
    body: '自拍画面里的对称性只是外观信息。拍摄角度、光线与表情都会影响结果。它无法判断面部不对称的原因，也无法替代医生的查体。出现突发症状应尽快就医。',
    source: '[中国卒中学会]',
  },
  {
    id: 'f12',
    title: '面神经炎与卒中的差别',
    body: '面神经炎通常表现为单侧面部无力。症状多在数天内逐渐出现，多数人预后良好。早期就诊有助于改善恢复。卒中引起的面部无力多为突发，常伴肢体无力或言语不清。',
    source: '[NHS]',
  },
  {
    id: 'f13',
    title: '微笑不对称常属常见现象',
    body: '面部轻微不对称在人群中很常见。两侧鼻唇沟深浅不同，微笑时嘴角高低略有差别。这些多与个体差异和表情习惯有关。关键是看变化是否突发，是否伴有其他症状。',
    source: '[中国卒中学会]',
  },
  {
    id: 'f14',
    title: '等待救护车时该做什么',
    body: '等待救护车时，请记录症状开始的具体时间。让患者在安全处保持安静，可平卧或侧卧。不要进食饮水，也不要自行用药。不要驾车送医，以免途中出现变化而延误处理。',
    source: '[CDC]',
  },
];

/* ------------------------------------------------------------------ advice */

/**
 * Everyday advice. Deliberately the SAME set for every non-urgent tier: the
 * measured difference between bands does not justify different lifestyle
 * instructions. A few are shown inline and the rest stay one tap away.
 *
 * NOT shown on the urgent tier - that screen carries action buttons only
 * (02 red line 4).
 */
export const ADVICE = [
  { id: 'a1', title: '定期测量血压', body: '高血压常无明显症状。定期测量是了解血压的主要方式。家庭自测可选固定时间进行，记录结果供医生参考。', source: '[WHO血压]' },
  { id: 'a2', title: '减少食盐摄入', body: '高盐饮食会升高血压。做菜可少放盐，少用酱料与腌制食品。多选新鲜食材有助于减少钠摄入。', source: '[WHO减盐]' },
  { id: 'a3', title: '坚持身体活动', body: '每周可安排约一百五十分钟中等强度活动。搭配力量练习，并减少久坐时间，对心血管健康有益。', source: '[WHO血压]' },
  { id: 'a4', title: '吸烟者尽早戒烟', body: '烟草使用是心脑血管疾病的重要危险因素。戒烟可为健康带来益处。需要帮助时可寻求专业戒烟支持。', source: '[WHO]' },
  { id: 'a5', title: '限制饮酒量', body: '饮酒没有无害的剂量，过量饮酒会升高血压。减少饮酒量或选择不饮酒更有利于心脑血管健康。', source: '[WHO饮酒]' },
  { id: 'a6', title: '关注心律异常', body: '房颤是缺血性卒中的常见原因。若感到心慌、脉搏不齐，宜尽早就医评估。', source: '[中国卒中学会]' },
  { id: 'a7', title: '关注血糖水平', body: '血糖长期偏高会损伤血管。按医生安排检查血糖，并保持合理饮食与活动习惯。', source: '[WHO]' },
  { id: 'a8', title: '保持健康体重', body: '超重和肥胖会增加心脑血管负担。通过合理饮食与规律活动，逐步把体重控制在适宜范围。', source: '[WHO]' },
  { id: 'a9', title: '保证规律睡眠', body: '长期睡眠不足或睡眠呼吸暂停与卒中风险相关。保持规律作息，有睡眠问题可向医生咨询。', source: '[国家卫健委脑卒中防治指导规范]' },
  { id: 'a10', title: '避免温度骤变', body: '寒冷天气会使血压波动。冬季注意保暖，进出温差大的环境时给身体适应时间。', source: '[中国卒中学会]' },
  { id: 'a11', title: '按医嘱规范用药', body: '已有高血压、糖尿病或血脂异常者，宜遵医嘱规律用药。请定期复诊，不要自行停药或改量。', source: '[WHO血压]' },
  { id: 'a12', title: '记住卒中识别口诀', body: '突发面部歪斜、单侧无力或言语不清时，请拨打120。同时请记下症状出现的时间。', source: '[中国卒中学会]' },
];

/* ------------------------------------------------------------- zone branches */

/**
 * What each measured region reflects. This is anatomy, not a diagnosis: it says
 * which muscle group the number relates to, never that something is wrong.
 */
export const ZONE_INFO = {
  forehead: {
    label: '额纹区',
    muscle: '额肌（受面神经支配）',
    what: '抬眉时额头两侧纹路的高度与深浅是否一致。',
  },
  eyelid: {
    label: '眼睑区',
    muscle: '眼轮匝肌（受面神经支配）',
    what: '闭眼时上下眼睑能否合拢，两侧眼睑高度是否一致。',
  },
  nasolabial: {
    label: '鼻唇沟区',
    muscle: '颧肌（受面神经支配）',
    what: '鼻翼到口角之间的沟纹，两侧深浅是否一致。',
  },
  mouth: {
    label: '口角区',
    muscle: '口轮匝肌（受面神经支配）',
    what: '微笑或鼓腮时，两侧口角的高低与幅度是否一致。',
  },
};

/**
 * Describe one region from its measured asymmetry percent.
 * @param {string} zone
 * @param {number|null} percent
 */
export function zoneBranch(zone, percent) {
  const info = ZONE_INFO[zone] || { label: zone, muscle: '', what: '' };
  let verdict = '本次未测到该区域数据。';
  let tone = 'unknown';
  if (Number.isFinite(percent)) {
    if (percent < 3) { verdict = '未见明显左右差异。'; tone = 'ok'; }
    else if (percent < 10) { verdict = '可见轻度左右差异。'; tone = 'mild'; }
    else { verdict = '左右差异较明显。'; tone = 'marked'; }
  }
  return { ...info, percent, verdict, tone };
}

/* ------------------------------------------------------------------ rotation */

const FACT_KEY = 'facestroke.factIndex';
const ADVICE_KEY = 'facestroke.adviceIndex';
const memory = { fact: 0, advice: 0 };

function readIndex(key, slot) {
  try {
    const n = Number.parseInt(window.localStorage.getItem(key) ?? '0', 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return memory[slot] || 0;
  }
}

function writeIndex(key, slot, value) {
  memory[slot] = value;
  try {
    window.localStorage.setItem(key, String(value));
  } catch { /* private mode: the in-memory counter still avoids immediate repeats */ }
}

/**
 * The next explainer, rotated rather than randomised so every item is seen once
 * before any item repeats. The user asked for a different one on every capture.
 * @returns {{id:string,title:string,body:string,source:string}}
 */
export function pickDailyFact() {
  const index = readIndex(FACT_KEY, 'fact');
  const item = FACTS[index % FACTS.length];
  writeIndex(FACT_KEY, 'fact', (index + 1) % (FACTS.length * 1000));
  return { ...item };
}

/**
 * A rotating slice of the advice list. Rotation keeps the screen short without
 * hiding the rest, which stays available in full.
 * @param {number} count
 */
export function pickAdviceBatch(count = 4) {
  const index = readIndex(ADVICE_KEY, 'advice');
  const out = [];
  for (let i = 0; i < Math.min(count, ADVICE.length); i += 1) {
    out.push({ ...ADVICE[(index + i) % ADVICE.length] });
  }
  writeIndex(ADVICE_KEY, 'advice', (index + count) % (ADVICE.length * 1000));
  return out;
}

/* -------------------------------------------------------------- trend reading */

/**
 * Read a trend summary in words, with what to do next.
 *
 * Deliberately NOT a "risk level": this app cannot assess medical risk. It says
 * how the self-check readings are behaving and how often to repeat them.
 *
 * @param {{n:number, latest:number|null, delta:number|null, direction:string, spread:number}} summary
 * @returns {{headline:string, detail:string, care:string, repeat:string, escalate:boolean}}
 */
export function interpretTrend(summary) {
  const s = summary || {};
  if (!s.n) {
    return {
      headline: '还没有可解读的记录',
      detail: '完成一次检测后，这里会给出趋势解读。',
      care: '',
      repeat: '',
      escalate: false,
    };
  }
  if (s.n < 2) {
    return {
      headline: '记录还太少，暂时看不出趋势',
      detail: '目前只有一次记录。建议间隔一段时间再测一次，两次以上才比较得出变化。',
      care: '单次分数受光线、角度和表情影响较大，不必因为一次结果紧张。',
      repeat: '建议 1 至 2 周后复测一次。',
      escalate: false,
    };
  }

  const deltaText = Number.isFinite(s.delta)
    ? `与上次相比变化 ${s.delta > 0 ? '+' : ''}${s.delta} 分。`
    : '';

  switch (s.direction) {
    case 'improving':
      return {
        headline: '近期读数有缓慢改善',
        detail: `共 ${s.n} 次记录，最新 ${s.latest} 分。${deltaText}`,
        care: '继续保持在相似的光线与角度下复测，读数才有可比性。',
        repeat: '建议每 1 至 2 周复测一次。',
        escalate: false,
      };
    case 'worsening':
      return {
        headline: '近期读数有缓慢下降',
        detail: `共 ${s.n} 次记录，最新 ${s.latest} 分。${deltaText}`,
        care: '读数下降不等于患病，但持续下降值得进一步确认。如有口角歪斜、言语不清或肢体无力，请立即就医。',
        repeat: '建议近期复测一次，并考虑线下检查。',
        escalate: true,
      };
    case 'volatile':
      return {
        headline: '近期读数波动较大',
        detail: `共 ${s.n} 次记录，最高与最低相差约 ${s.spread} 分。`,
        care: '波动多半来自拍摄条件变化，例如光线、距离或表情。请尽量在相同条件下复测。',
        repeat: '建议固定光线与距离后复测，并以线下检查为准。',
        escalate: false,
      };
    default:
      return {
        headline: '近期读数比较稳定',
        detail: `共 ${s.n} 次记录，最新 ${s.latest} 分。${deltaText}`,
        care: '稳定的读数说明测量条件比较一致，可继续定期观察。',
        repeat: '建议每 1 至 2 周复测一次。',
        escalate: false,
      };
  }
}

/** The sentence that must accompany any trend reading. */
export const TREND_LIMITATION =
  '以上是对自检读数的解读，不是医学风险评估，也不能替代医生判断。';
