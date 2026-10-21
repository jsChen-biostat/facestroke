/**
 * S4 · 拍摄前准备
 * Spec: 03 功能规格 S4 / 06 §3.4
 *
 * 2026-10-02: formal copy; the palsy marker explanation made explicit; the
 * recorded intake answers are echoed so the user can see and correct them.
 */

import { readSettings, setSetting } from '../core/settings.js';
import { guide, speak } from '../core/tts.js';
import { SYMPTOM_LABEL } from './s3_gate.js';

export default {
  id: 'prep',
  route: '#/prep',
  title: '拍摄前准备',

  render(root, ctx) {
    const s = readSettings();
    const gate = ctx.state.gate;
    const symptoms = (gate?.symptoms || []).filter((x) => x !== 'none');
    const recorded = symptoms.length
      ? symptoms.map((x) => SYMPTOM_LABEL[x] || x).join('、')
      : '以上均无';

    root.innerHTML = `
      <h1 class="screen-title">拍摄前准备</h1>

      <div class="card">
        <span class="q-title">拍摄时会引导您完成三个动作</span>
        <p>① 抬起眉毛　② 露齿微笑　③ 用力闭眼</p>
        <p class="small">这三个动作会由摄像头实际测量，用于观察做表情时两侧的变化是否对称，并计入本次结果。</p>
      </div>

      <div class="card">
        <span class="q-title">已记录的基础信息</span>
        <p class="small">目前症状：${recorded}</p>
        <p class="small">如填写有误，可返回上一页修改。</p>
        <button class="btn-secondary" data-back>返回修改</button>
      </div>

      <label class="opt">
        <input type="checkbox" id="palsy" ${s.palsy ? 'checked' : ''} />
        <span>我有面神经疾病或近期面部外观变化</span>
      </label>
      <p class="small">勾选后，评估结果不会因已知的面部不对称而反复提示需要留意。</p>

      <button class="btn-primary" data-nav="#/capture">开始拍摄</button>`;

    root.querySelector('#palsy').addEventListener('change', (e) => {
      setSetting('palsy', e.target.checked);
    });

    guide('拍摄时会引导您完成三个动作：抬起眉毛，露齿微笑，用力闭眼。'
      + '这三个动作会被实际测量，并计入本次结果。'
      + '并请在光线均匀、额头与口角无遮挡的环境下拍摄。');
    speak('准备好后，点击下方按钮开始拍摄。');
  },
};
