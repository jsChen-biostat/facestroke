/**
 * S1 · 授权说明（首次启动）
 * Spec: 03 功能规格 S1 / 06 §3.1 / 02 §7 / 09 合规文件包 第一节
 *
 * RED LINES: no pre-ticked box, no "using the app means you agree", declining exits.
 * 2026-10-02: formal register (user feedback).
 */

import { grantConsent, declineConsent } from '../core/consent.js';
import { guide } from '../core/tts.js';

export default {
  id: 'consent',
  route: '#/consent',
  title: '授权说明',

  render(root, ctx) {
    root.innerHTML = `
      <h1 class="screen-title">授权说明</h1>
      <p class="screen-sub">开始使用前，请阅读以下说明。</p>

      <div class="card">
        <ol class="legal">
          <li>本应用将使用您的<b>面部图像</b>，用途为<b>健康风险评估</b>，仅在<b>本机</b>处理与保存。</li>
          <li>图像<b>不会上传</b>，不会用于身份识别，不会提供给第三方。</li>
          <li>本应用<b>不是医疗器械</b>，结果<b>仅供参考</b>，不能作为诊断依据。</li>
          <li>您可随时<b>撤回授权</b>并删除全部数据。</li>
        </ol>
      </div>

      <label class="opt">
        <input type="checkbox" id="consent-check" />
        <span>我已阅读并理解上述说明，同意将面部图像用于本机健康风险评估</span>
      </label>

      <button id="agree" class="btn-primary" type="button" disabled>同意并继续</button>
      <button id="decline" class="btn-secondary" type="button">不同意并退出</button>
      <p class="small mt">未勾选前按钮不可用。选择「不同意并退出」将关闭本应用，不会进入任何功能。</p>
      <div class="card mt">
        <p class="small">完整条款请见「免责声明」与「隐私与数据」页面。授权记录（版本号与时间戳）
        仅保存在本机，可在设置页查看与撤回。</p>
      </div>`;

    const agree = root.querySelector('#agree');
    root.querySelector('#consent-check').addEventListener('change', (e) => {
      agree.disabled = !e.target.checked; // positive action required, never pre-ticked
    });

    agree.addEventListener('click', () => {
      ctx.state.consent = grantConsent();
      ctx.resetStack();
      ctx.navigate('#/home');
    });

    root.querySelector('#decline').addEventListener('click', () => {
      declineConsent();
      document.body.innerHTML =
        '<p style="padding:24px;font-size:20px">已退出。未取得您的授权，本应用不会处理任何面部图像。<br>'
        + '如需重新开始，请关闭页面后再次打开。</p>';
    });

    guide('授权说明。本应用将使用您的面部图像进行健康风险评估，仅在本机处理与保存。'
      + '图像不会上传，不会用于身份识别。本应用不是医疗器械，结果仅供参考。'
      + '您可以随时撤回授权。');
  },
};
