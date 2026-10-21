/**
 * S2 · 首页
 * Spec: 03 功能规格 S2 / 06 §3.2
 *
 * 2026-10-02: copy rewritten to a more formal register (user feedback: the
 * wording was too colloquial). Consent is enforced here and on every processing
 * screen.
 */

import { hasValidConsent } from '../core/consent.js';
import { speak } from '../core/tts.js';

export default {
  id: 'home',
  route: '#/home',
  title: '首页',

  render(root, ctx) {
    if (!hasValidConsent()) {
      setTimeout(() => ctx.navigate('#/consent'), 0);
      root.innerHTML = '<p class="screen-sub">正在打开授权说明…</p>';
      return;
    }

    root.innerHTML = `
      <h1 class="screen-title">FaceStroke 面部健康自检</h1>
      <p class="screen-sub">使用手机前置摄像头测量面部左右对称度，生成参考性评估结果。</p>

      <button class="btn-primary" data-nav="#/gate">开 始 检 测</button>

      <button class="btn-secondary" data-nav="#/records">历史记录</button>
      <button class="btn-secondary" data-nav="#/algorithm">评估原理说明</button>
      <button class="btn-secondary" data-nav="#/privacy">隐私与数据</button>
      <button class="btn-secondary" data-nav="#/settings">设置</button>

      <p class="small mt center">本工具不是医疗器械，结果仅供参考，不能替代医生判断。</p>`;

    speak('FaceStroke 面部健康自检。点击下方按钮开始检测。');
  },
};
