/**
 * S3 · 基础信息问卷（3 题）
 * Spec: 03 功能规格 S3 / 02 §3
 *
 * 2026-10-02 changes (user feedback):
 *  - ALL THREE questions are now required. Previously Q3 could be skipped, which
 *    made the symptom decision ambiguous and could send the user straight to the
 *    urgent screen with no explanation and no way back.
 *  - the answers are echoed on the next screen so the user can see what was
 *    recorded, and can go back and correct them.
 *  - copy moved to a formal register.
 */

import { CONFIG } from '../core/config.js';
import { guide } from '../core/tts.js';

/** Same decision table as 02_产品定义与合规边界.md section 3. */
export function decideGate(gate) {
  const symptoms = (gate.symptoms || []).filter((s) => s !== 'none');
  if (symptoms.length > 0) return 'EMERGENCY';            // life first, skip the model
  const riskyAge = CONFIG.gate.riskAgeBands.includes(gate.ageBand);
  const riskyFlags = (gate.risks || []).some((r) => r !== 'none' && r !== 'unsure');
  return riskyAge || riskyFlags ? 'UNLOCK_RISK_LAYER' : 'BASIC_ONLY';
}

export const SYMPTOM_LABEL = {
  face: '口角歪斜',
  speech: '言语不清',
  arm: '一侧肢体无力',
  none: '以上均无',
};

const AGE_BANDS = [
  { v: 'under45', label: '45 岁以下' },
  { v: '45-59', label: '45–59 岁' },
  { v: '60-74', label: '60–74 岁' },
  { v: '75+', label: '75 岁以上' },
];
const RISKS = [
  { v: 'hypertension', label: '高血压' },
  { v: 'diabetes', label: '糖尿病' },
  { v: 'af', label: '心房颤动' },
  { v: 'lipids', label: '血脂异常' },
  { v: 'none', label: '以上均无' },
  { v: 'unsure', label: '不清楚' },
];
const SYMPTOMS = [
  { v: 'face', label: '口角歪斜' },
  { v: 'speech', label: '言语不清' },
  { v: 'arm', label: '一侧肢体无力' },
  { v: 'none', label: '以上均无' },
];

function choices(name, items, multi) {
  return items.map((it) => `
    <label class="opt">
      <input type="${multi ? 'checkbox' : 'radio'}" name="${name}" value="${it.v}" />
      <span>${it.label}</span>
    </label>`).join('');
}

export default {
  id: 'gate',
  route: '#/gate',
  title: '基础信息',

  render(root, ctx) {
    root.innerHTML = `
      <h1 class="screen-title">基础信息</h1>
      <p class="screen-sub">用于判断本次评估是否适用于您。三项均需选择，约 15 秒。</p>

      <div class="card q-block">
        <span class="q-title">1. 您的年龄段</span>
        ${choices('age', AGE_BANDS, false)}
      </div>
      <div class="card q-block">
        <span class="q-title">2. 您是否有以下既往病史（可多选）</span>
        ${choices('risk', RISKS, true)}
      </div>
      <div class="card q-block">
        <span class="q-title">3. 您目前是否存在以下症状（可多选）</span>
        ${choices('symptom', SYMPTOMS, true)}
      </div>

      <button id="next" class="btn-primary" type="button">下一步</button>
      <button class="btn-secondary" data-back type="button">返回</button>
      <p id="hint" class="small mt"></p>`;

    // highlight picked options; "以上均无" clears the others in its group
    root.querySelectorAll('input[type="checkbox"], input[type="radio"]').forEach((input) => {
      input.addEventListener('change', () => {
        const name = input.name;
        if (input.type === 'checkbox' && input.value === 'none' && input.checked) {
          root.querySelectorAll(`input[name="${name}"]`).forEach((o) => {
            if (o !== input) o.checked = false;
          });
        } else if (input.type === 'checkbox' && input.checked) {
          const none = root.querySelector(`input[name="${name}"][value="none"]`);
          if (none) none.checked = false;
        }
        root.querySelectorAll(`input[name="${name}"]`).forEach((o) => {
          o.closest('.opt')?.classList.toggle('picked', o.checked);
        });
      });
    });

    root.querySelector('#next').addEventListener('click', () => {
      const pick = (n) => [...root.querySelectorAll(`input[name="${n}"]:checked`)].map((e) => e.value);
      const gate = {
        ageBand: pick('age')[0] || null,
        risks: pick('risk'),
        symptoms: pick('symptom'),
      };

      // every question is required now; say exactly which one is missing
      const missing = [];
      if (!gate.ageBand) missing.push('第 1 题（年龄段）');
      if (!gate.risks.length) missing.push('第 2 题（既往病史）');
      if (!gate.symptoms.length) missing.push('第 3 题（目前症状）');
      if (missing.length) {
        root.querySelector('#hint').textContent = `请完成：${missing.join('、')}。`;
        root.querySelector('#hint').classList.add('warn');
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }

      const mode = decideGate(gate);
      ctx.state.gate = gate;
      ctx.state.mode = mode;

      if (mode === 'EMERGENCY') ctx.navigate('#/result');   // urgent path: no model call
      else ctx.navigate('#/prep');
    });

    guide('请完成三项基础信息。第一，年龄段。第二，是否有高血压、糖尿病、心房颤动、血脂异常等既往病史。'
      + '第三，目前是否存在口角歪斜、言语不清、一侧肢体无力等症状。');
  },
};
