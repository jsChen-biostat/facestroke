/**
 * S10 · 历史记录
 * Spec: 03 功能规格 S10
 * 2026-10-02: formal register + back navigation (user feedback).
 *
 * RED LINE: records contain scores and measurements only - never images.
 * The chart is drawn on a plain canvas: no charting library, no network.
 */

import { listRecords, clearAll } from '../core/storage.js';
import { readSettings, setSetting } from '../core/settings.js';
import { summarizeTrend, chartPoints } from '../core/trend.js';
import { TIER_LABEL } from '../core/report.js';
import { interpretTrend, TREND_LIMITATION, ADVICE } from '../core/knowledge.js';
import { speak } from '../core/tts.js';

const REMINDERS = [
  { v: 'off', label: '不提醒' },
  { v: 'weekly', label: '每周' },
  { v: 'biweekly', label: '每两周' },
  { v: 'monthly', label: '每月' },
];

function drawChart(canvas, records) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 320;
  const cssH = 180;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.height = `${cssH}px`;
  const c = canvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, cssW, cssH);

  const padding = 28;
  const { points, xLabels, yTicks } = chartPoints(records, { width: cssW, height: cssH, padding });

  c.font = '12px system-ui, sans-serif';
  c.strokeStyle = '#d3dce6';
  c.fillStyle = '#4a5a6a';
  for (const t of yTicks) {
    c.beginPath();
    c.moveTo(padding, t.y);
    c.lineTo(cssW - padding, t.y);
    c.stroke();
    c.fillText(t.text, 4, t.y + 4);
  }
  for (const l of xLabels) c.fillText(l.text, l.x - 14, cssH - 8);

  if (points.length === 0) {
    c.fillText('暂无记录', padding, cssH / 2);
    return;
  }
  if (points.length === 1) {
    c.fillStyle = '#0b6bcb';
    c.beginPath();
    c.arc(points[0].x, points[0].y, 5, 0, Math.PI * 2);
    c.fill();
    return;
  }

  c.strokeStyle = '#0b6bcb';
  c.lineWidth = 2.5;
  c.beginPath();
  points.forEach((p, i) => (i === 0 ? c.moveTo(p.x, p.y) : c.lineTo(p.x, p.y)));
  c.stroke();

  c.fillStyle = '#0b6bcb';
  for (const p of points) {
    c.beginPath();
    c.arc(p.x, p.y, 4, 0, Math.PI * 2);
    c.fill();
  }
}

export default {
  id: 'records',
  route: '#/records',
  title: '历史记录',

  async render(root, ctx) {
    root.innerHTML = `
      <h1 class="screen-title">历史记录</h1>
      <div class="card" id="summary"><p class="small">正在读取…</p></div>
      <div class="card">
        <span class="q-title">趋势</span>
        <canvas id="chart" style="width:100%"></canvas>
      </div>
      <div class="card" id="reading">
        <span class="q-title">趋势解读</span>
        <p class="small">正在解读…</p>
      </div>
      <div class="card">
        <span class="q-title">复测提醒</span>
        <p class="small">提醒仅在本机生效，用于协助您按期复测。</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
          ${REMINDERS.map((r) => `<button class="btn-secondary" style="width:auto;flex:1;min-width:88px;margin-top:0" data-rem="${r.v}">${r.label}</button>`).join('')}
        </div>
        <p class="small mt" id="rem-note"></p>
      </div>
      <div class="card">
        <span class="q-title">记录明细</span>
        <div id="list"><p class="small">—</p></div>
      </div>
      <button class="btn-primary" data-nav="#/gate">开始一次检测</button>
      <button class="btn-secondary" id="wipe">清除全部记录</button>
      <p class="small mt">记录仅保存在本机，内容为分数与分项数值，不含照片。卸载应用即清除。</p>
      <button class="btn-secondary" data-back>返回</button>`;

    let records = [];
    try {
      records = await listRecords();
    } catch (err) {
      console.warn('[FaceStroke] listRecords failed', err);
    }

    const trend = summarizeTrend(records);
    const summaryEl = root.querySelector('#summary');
    if (!records.length) {
      summaryEl.innerHTML = '<p>暂无记录。</p><p class="small">完成一次检测后将自动保存于此。</p>';
    } else {
      summaryEl.innerHTML = `
        <p><b>最近一次：${trend.latest} 分</b>${trend.previous !== null ? ` · 上次 ${trend.previous} 分` : ''}</p>
        <p class="small">${trend.phrase}（共 ${trend.n} 次记录，极差 ${trend.spread} 分）</p>`;
      speak(`最近一次 ${trend.latest} 分。${trend.phrase}`);
    }

    drawChart(root.querySelector('#chart'), records);
    window.addEventListener('resize', () => drawChart(root.querySelector('#chart'), records), { once: true });

    // trend reading: how the readings are behaving, and what to do next
    const reading = interpretTrend(trend);
    const readingEl = root.querySelector('#reading');
    readingEl.innerHTML = `
      <p><b>${reading.headline}</b></p>
      <p class="small">${reading.detail}</p>
      ${reading.care ? `<p class="small">${reading.care}</p>` : ''}
      ${reading.repeat ? `<p class="small">复测建议：${reading.repeat}</p>` : ''}
      ${reading.escalate ? '<p class="small warn">建议尽快安排一次线下检查。</p>' : ''}
      <p class="small">${TREND_LIMITATION}</p>
      ${records.length ? `<details class="landmark-panel mt">
        <summary>查看全部 ${ADVICE.length} 条日常建议</summary>
        <ul class="advice-list">${ADVICE.map((a) => `<li><b>${a.title}</b>　${a.body}</li>`).join('')}</ul>
        <p class="small">建议依据：WHO、中国卒中学会、国家卫健委等公开资料。</p>
      </details>` : ''}`;

    const listEl = root.querySelector('#list');
    if (!records.length) {
      listEl.innerHTML = '<p class="small">—</p>';
    } else {
      const rows = records.slice().reverse().map((r) => {
        const date = String(r.timestamp || '').slice(0, 10);
        const tierText = r.tier ? TIER_LABEL[r.tier] : '未分档';
        return `<tr><td>${date}</td><td>${r.score}</td><td class="small">${tierText}</td></tr>`;
      }).join('');
      listEl.innerHTML = `<table class="kv">
        <tr><td><b>日期</b></td><td><b>分数</b></td><td><b>结论</b></td></tr>${rows}</table>`;
    }

    const noteEl = root.querySelector('#rem-note');
    const paint = () => {
      const cur = readSettings().reminder;
      noteEl.textContent = cur === 'off' ? '当前：不提醒。' : `当前：${REMINDERS.find((r) => r.v === cur)?.label}提醒。`;
      root.querySelectorAll('[data-rem]').forEach((b) => {
        const on = b.getAttribute('data-rem') === cur;
        b.style.borderColor = on ? 'var(--c-primary)' : '';
        b.style.borderWidth = on ? '2px' : '1px';
      });
    };
    paint();
    root.querySelectorAll('[data-rem]').forEach((b) => {
      b.addEventListener('click', () => {
        setSetting('reminder', b.getAttribute('data-rem'));
        paint();
      });
    });

    root.querySelector('#wipe').addEventListener('click', async () => {
      if (!window.confirm('确定要清除全部记录吗？清除后无法恢复。')) return;
      await clearAll();
      ctx.navigate('#/records');
    });
  },
};
