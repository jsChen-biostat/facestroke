/**
 * S11 · 设置
 * Spec: 03 功能规格 S11 / 06 §3.10 / 02 §7 / 09 合规与伦理文件包
 *
 * 2026-10-02 changes (user feedback):
 *  - all developer-facing text removed from the normal UI. Model fingerprints and
 *    config state now live behind the long-press developer panel only.
 *  - added the emergency contact used by the 通知家人 action
 *  - formal copy
 */

import { CONFIG, missingConfig } from '../core/config.js';
import { readSettings, setSetting, applyFontSize } from '../core/settings.js';
import { readConsent, revokeConsent, hasValidConsent } from '../core/consent.js';
import { clearAll, countRecords } from '../core/storage.js';
import { speak, stopSpeaking, isSupported as ttsSupported } from '../core/tts.js';

const SIZES = [
  { v: 'normal', label: '标准' },
  { v: 'large', label: '大' },
  { v: 'xlarge', label: '超大' },
];

function toggleButton(id, on, label) {
  return `<button class="btn-secondary" id="${id}" aria-pressed="${on}">
    ${label}：<b>${on ? '已开启' : '已关闭'}</b></button>`;
}

export default {
  id: 'settings',
  route: '#/settings',
  title: '设置',

  async render(root, ctx) {
    const s = readSettings();
    const consent = readConsent();
    let recordCount = 0;
    try {
      recordCount = await countRecords();
    } catch { /* storage unavailable */ }

    root.innerHTML = `
      <h1 class="screen-title">设置</h1>

      <div class="card">
        <span class="q-title">显示</span>
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
          ${SIZES.map((x) => `
            <button class="btn-secondary" style="width:auto;flex:1;min-width:90px;margin-top:0"
              data-fs="${x.v}" aria-pressed="${s.fontSize === x.v}">
              ${x.label}${s.fontSize === x.v ? ' ✓' : ''}
            </button>`).join('')}
        </div>
        <p class="small mt">调整后全应用文字同步放大。</p>
      </div>

      <div class="card">
        <span class="q-title">语音</span>
        ${ttsSupported() ? `
          ${toggleButton('btn-voice', s.voice, '朗读检测结果')}
          ${toggleButton('btn-guidance', s.voiceGuidance, '朗读操作引导')}
          <button class="btn-secondary" id="btn-test-voice">试听</button>
        ` : '<p class="small">当前设备不支持语音朗读。</p>'}
      </div>

      <div class="card">
        <span class="q-title">紧急联系人</span>
        <p class="small">用于「通知家人」功能，仅保存在本机。</p>
        <label class="field-label mt" for="ec-name">称呼</label>
        <input class="field-input" id="ec-name" type="text" inputmode="text"
               placeholder="例如：女儿" value="${s.emergencyName || ''}" />
        <label class="field-label mt" for="ec-phone">手机号</label>
        <input class="field-input" id="ec-phone" type="tel" inputmode="tel"
               placeholder="例如：13800000000" value="${s.emergencyContact || ''}" />
        <button class="btn-secondary" id="btn-save-contact">保存联系人</button>
        <p class="small form-note" id="contact-note"></p>
      </div>

      <div class="card">
        <span class="q-title">个人情况</span>
        ${toggleButton('btn-palsy', s.palsy, '我有面神经疾病或近期面部外观变化')}
        <p class="small mt">开启后，评估结果不会因已知的面部不对称而反复提示需要留意。</p>
      </div>

      <div class="card">
        <span class="q-title">隐私与数据</span>
        <p class="small">授权记录：${consent
          ? `${consent.result === 'agreed' ? '已授权' : '未授权'} · 版本 ${consent.version} · ${String(consent.timestamp || '').slice(0, 10)}${consent.revokedAt ? ` · 已于 ${String(consent.revokedAt).slice(0, 10)} 撤回` : ''}`
          : '无'}</p>
        <p class="small">本机记录：${recordCount} 条（不含照片）</p>
        <button class="btn-secondary" data-nav="#/privacy">隐私与数据说明</button>
        <button class="btn-secondary" data-nav="#/disclaimer">免责声明</button>
        <button class="btn-secondary" data-nav="#/algorithm">评估原理说明</button>
        <button class="btn-secondary" id="btn-revoke">撤回授权</button>
        <button class="btn-secondary" id="btn-wipe">删除本机全部数据</button>
        <p class="small mt">撤回授权后本应用将立即停止处理面部图像；删除数据不可恢复。</p>
      </div>

      <div class="card">
        <span class="q-title">关于</span>
        <p class="small">FaceStroke 面部健康自检 · 版本 ${CONFIG.appVersion}</p>
        <p class="small" id="dev-hint">本工具不是医疗器械，结果仅供参考。</p>
        <div id="dev-panel" class="hidden"></div>
      </div>

      <button class="btn-secondary" data-home>返回首页</button>`;

    if (!hasValidConsent()) {
      root.querySelector('.screen-title')?.insertAdjacentHTML('afterend',
        '<p class="small warn">当前没有有效的授权记录，检测功能不可用。</p>');
    }

    /* ----------------------------------------------------------- font size */
    root.querySelectorAll('[data-fs]').forEach((b) => {
      b.addEventListener('click', () => {
        const v = b.getAttribute('data-fs');
        setSetting('fontSize', v);
        applyFontSize(v);
        this.render(root, ctx);
      });
    });

    /* ---------------------------------------------------------- voice */
    root.querySelector('#btn-voice')?.addEventListener('click', () => {
      const next = !readSettings().voice;
      setSetting('voice', next);
      this.render(root, ctx);
      if (next) speak('语音朗读已开启。');
    });
    root.querySelector('#btn-guidance')?.addEventListener('click', () => {
      setSetting('voiceGuidance', !readSettings().voiceGuidance);
      this.render(root, ctx);
    });
    root.querySelector('#btn-test-voice')?.addEventListener('click', () => {
      speak('这是一段试听。检测结果会以同样的方式朗读。', { force: true });
    });

    /* -------------------------------------------------- emergency contact */
    root.querySelector('#btn-save-contact').addEventListener('click', () => {
      const name = (root.querySelector('#ec-name').value || '').trim();
      const phone = (root.querySelector('#ec-phone').value || '').trim();
      const note = root.querySelector('#contact-note');
      if (phone && !/^[0-9+\-\s]{5,20}$/.test(phone)) {
        note.textContent = '手机号格式不正确，请检查后重试。';
        note.classList.add('warn');
        return;
      }
      setSetting('emergencyName', name);
      setSetting('emergencyContact', phone);
      note.classList.remove('warn');
      note.textContent = phone ? '已保存。' : '已清空联系人。';
    });

    /* -------------------------------------------------------------- palsy */
    root.querySelector('#btn-palsy')?.addEventListener('click', () => {
      setSetting('palsy', !readSettings().palsy);
      this.render(root, ctx);
    });

    /* ------------------------------------------------------------ revoke */
    root.querySelector('#btn-revoke')?.addEventListener('click', async () => {
      if (!window.confirm('确定要撤回授权吗？撤回后本应用将立即停止处理面部图像。')) return;
      stopSpeaking();
      revokeConsent();
      if (window.confirm('是否同时删除本机已保存的全部记录？')) {
        await clearAll();
      }
      alert('已撤回授权。您将返回授权说明页；未重新授权则无法使用检测功能。');
      ctx.resetStack();
      ctx.navigate('#/consent');
    });

    /* -------------------------------------------------------------- wipe */
    root.querySelector('#btn-wipe')?.addEventListener('click', async () => {
      if (!window.confirm('删除后无法恢复。确定要删除本机全部记录吗？')) return;
      await clearAll();
      alert('已删除本机全部记录。');
      this.render(root, ctx);
    });

    root.querySelector('[data-home]')?.addEventListener('click', () => {
      ctx.resetStack();
      ctx.navigate('#/home');
    });

    /* ------------------------------------------------- developer panel */
    let taps = 0;
    let timer = null;
    const hint = root.querySelector('#dev-hint');
    const panel = root.querySelector('#dev-panel');
    hint.addEventListener('click', async () => {
      taps += 1;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { taps = 0; }, 1200);
      if (taps < 5) return;
      taps = 0;
      const fp = CONFIG.fingerprints;
      const cnt = await countRecords().catch(() => 0);
      panel.classList.remove('hidden');
      panel.innerHTML = `
        <p class="small">安全上下文：${window.isSecureContext ? '是' : '否'}</p>
        <p class="small">记录条数：${cnt}</p>
        <p class="small">模型指纹：几何 ${fp.geo} · AI ${fp.cnn || '未加载'} · 融合 ${fp.fusion}</p>
        <p class="small">未确认参数：${missingConfig().join('、') || '无'}</p>
        <p class="small">上次采集指标：${JSON.stringify(ctx.state.lastResult?.captureMetrics || null)}</p>`;
    });
  },
};
