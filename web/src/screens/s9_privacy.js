/**
 * S9 · 隐私与数据说明
 * Spec: 03 功能规格 S9 / 06 §3.9
 * 2026-10-02: formal register (user feedback).
 */

import { guide } from '../core/tts.js';

export default {
  id: 'privacy',
  route: '#/privacy',
  title: '隐私与数据',

  render(root, ctx) {
    root.innerHTML = `
      <h1 class="screen-title">隐私与数据</h1>

      <div class="card">
        <span class="q-title">数据不出本机</span>
        <ul class="legal">
          <li>全部检测均在手机本地完成；</li>
          <li>面部图像<b>不会上传</b>，不会用于身份识别，不提供给第三方；</li>
          <li>图像在处理完成后立即从内存释放，<b>不写入任何文件</b>；</li>
          <li>历史记录仅保存分数与分项数值，<b>不含图像</b>；</li>
          <li>本应用没有账号体系，卸载即清除全部本地数据。</li>
        </ul>
      </div>

      <div class="card">
        <span class="q-title">自行验证方式</span>
        <p>打开手机的<b>飞行模式</b>（关闭 Wi-Fi 与移动数据），再进行一次检测。
        若仍能正常完成，即说明本应用未进行网络传输。</p>
        <button class="btn-secondary" id="fly-test">开始一次飞行模式检测</button>
      </div>

      <div class="card">
        <span class="q-title">您的权利</span>
        <ul class="legal">
          <li>可随时在「设置」中<b>撤回授权</b>，撤回后立即停止处理面部图像；</li>
          <li>可随时<b>删除本机全部数据</b>，删除后不可恢复；</li>
          <li>可随时查看本机保存的全部记录。</li>
        </ul>
      </div>

      <button class="btn-secondary" data-back>返回</button>`;

    root.querySelector('#fly-test').addEventListener('click', () => {
      ctx.state.mode = null;
      ctx.state.gate = null;
      ctx.navigate('#/gate');
    });

    guide('隐私与数据说明。全部检测均在手机本地完成，面部图像不会上传，不会用于身份识别，'
      + '图像在处理后立即从内存释放。您可以随时撤回授权或删除本机全部数据。');
  },
};
