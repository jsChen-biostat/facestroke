/**
 * S7 · 结果页（核心）
 * Spec: 03 功能规格 S7 / 02 §4 措辞分级 / 02 §5 误诊防范 / 06 §3.7
 *
 * 2026-10-02 changes (user feedback round 1):
 *  - the urgent screen NO LONGER traps the user: it has 返回, and it states which
 *    reported symptoms triggered it, plus a way to correct the answers. Previously
 *    entering it meant force-quitting the app.
 *  - 附近医院 opens the system map app; 通知家人 sends an SMS to a saved emergency
 *    contact (or asks the user to set one). Previously only 120 did anything.
 *  - all developer-facing text was removed. Users are not developers.
 */

import { CONFIG } from '../core/config.js';
import {
  TIER_LABEL, TIER_TEXT, DIFFERENTIAL_REMINDER, DISCLAIMER_SHORT,
  ZONE_LABELS, scanText, BANNED_PATTERNS, ADVICE_PATTERNS, SYMPTOM_ONLY,
  RESULT_LIMITATION, ACTION_LABELS, ACTION_TEST_NOTE, actionSkipText,
} from '../core/report.js';
import { addRecord, listRecords } from '../core/storage.js';
import { readSettings } from '../core/settings.js';
import { speak } from '../core/tts.js';
import { saveReportToGallery, shareReportImage } from '../core/reportImage.js';
import { ADVICE, zoneBranch } from '../core/knowledge.js';
import { antiRefreshNote, sameDayCount } from '../core/policy.js';
import { SYMPTOM_LABEL } from './s3_gate.js';
import { openNearbyHospitals, notifyFamily } from '../core/emergency.js';

let savedTimestamp = null;

function scaleBar(score, thresholds) {
  const pct = Math.max(0, Math.min(100, score));
  const marks = [
    { v: thresholds.cMin, label: '就诊' },
    { v: thresholds.bMin, label: '观察' },
    { v: thresholds.aMin, label: '良好' },
  ].filter((m) => Number.isFinite(m.v));
  return `
    <div class="scale">
      <div class="scale-track">
        <div class="scale-fill" style="width:${pct}%"></div>
        <div class="scale-pin" style="left:${pct}%">${score}</div>
      </div>
      <div class="scale-ticks">
        ${marks.map((m) => `<span style="left:${m.v}%">${m.label} ${m.v}</span>`).join('')}
      </div>
    </div>`;
}

const ZONE_ORDER = ['forehead', 'eyelid', 'nasolabial', 'mouth'];

function zoneRows(zones) {
  return ZONE_ORDER
    .filter((z) => zones?.[z])
    .map((z) => {
      const p = zones[z].percent;
      return `<tr><td>${ZONE_LABELS[z]}</td><td>${p === null || p === undefined ? '—' : `${p}%`}</td></tr>`;
    }).join('');
}

/**
 * 第二个评估通道。
 *
 * 设计要点（来自使用者反馈）：
 *  1. **方向必须与几何分数一致**。几何分数是"越高越对称"，模型原本输出的是
 *     "越不对称概率越高" —— 两个数字方向相反地摆在同一屏，读起来自相矛盾。
 *     现在模型也只给"结论"，并用与几何分数相同的措辞。
 *  2. **不写任何训练相关的内容**（AUC、样本量、特征工程）。那是开发者的信息，
 *     属于「查看评估原理」页，不属于结果报告。
 *  3. 它的**唯一作用就是一致性核对**：两个方法都指向同一结论时更可信；
 *     不一致时如实说明，而不是让其中一个去"否决"另一个。
 */
/**
 * 四网络集成通道（与文献同一个框架）。
 * 按使用者要求：结果页**不写任何训练相关的内容**（骨干名、AUC、样本量都不出现）。
 * 唯一的例外是"该模型尚未训练"这一句 —— 它不是开发信息，而是必须的诚实声明：
 * 一个未训练模型的输出如果不加标注，就会被误读成风险判断。
 */
function ensembleBlock(res) {
  const e = res.strokeEnsemble;
  if (!e) return '';
  const pct = Math.round(e.probability * 1000) / 10;
  return `
      <div class="card">
        <b>四网络集成通道</b>
        <p class="score-big small-big">${pct}%</p>
        <p class="small">四个网络各自判断后取平均的结果。</p>
        ${e.trained
          ? '<p class="small">本通道采用与文献相同的集成框架。</p>'
          : '<p class="small warn">该模型尚未训练，此数值仅用于演示完整流程，<b>不代表任何真实风险</b>，不能作为诊断依据。</p>'}
      </div>`;
}
function asymmetryBlock(res, tier) {
  const m = res.asymmetryModel;
  if (!m) return '';
  const p = m.probability;
  const verdict = p <= 0.35 ? '未见明显不对称'
    : p <= 0.65 ? '介于两者之间，不够明确'
      : '可见明显不对称';
  const modelClean = p <= 0.5;
  const geoClean = tier === 'A';
  const agree = modelClean === geoClean;

  return `
      <div class="card">
        <b>第二通道 · 面部不对称检测</b>
        <p>${verdict}</p>
        <p class="small">它与几何测量看的是同一件事（左右是否对称），只是方法不同。</p>
        <p class="small ${agree ? '' : 'warn'}">${agree
          ? '两个方法的结论一致。'
          : '两个方法的结论不一致，本次结果请谨慎参考，建议在相同光线下重测一次。'}</p>
        <p class="small">本通道为初版，不区分病因，不能作为诊断依据。</p>
      </div>`;
}

function zoneBranches(zones) {
  return ZONE_ORDER.map((z) => {
    const b = zoneBranch(z, zones?.[z]?.percent);
    const value = Number.isFinite(b.percent) ? `${b.percent}%` : '未测到';
    return `
      <div class="zone-branch">
        <b>${b.label}　<span class="zone-value">${value}</span></b>
        <p class="small">${b.verdict}</p>
        <p class="small">该区域反映${b.muscle}。${b.what}</p>
      </div>`;
  }).join('');
}

/** The three urgent actions, rendered once and reused by both urgent paths. */
function urgentActions() {
  return `
    <button class="btn-primary" id="nearby">查看附近医院 / 卒中中心</button>
    <button class="btn-secondary" id="call120">拨打 120</button>
    <button class="btn-secondary" id="notify">通知家人</button>
    <p class="small mt" id="action-note"></p>`;
}

function wireUrgentActions(root, ctx) {
  const note = root.querySelector('#action-note');
  root.querySelector('#nearby')?.addEventListener('click', () => {
    if (note) note.textContent = '正在打开地图…';
    openNearbyHospitals().then((r) => {
      if (!note) return;
      note.textContent = r === 'opened'
        ? '已尝试打开地图应用；如未跳转，请手动打开地图搜索「卒中中心」。'
        : '无法自动打开地图，请手动打开地图应用搜索「卒中中心」。';
    });
  });
  root.querySelector('#call120')?.addEventListener('click', () => {
    window.location.href = 'tel:120';
  });
  root.querySelector('#notify')?.addEventListener('click', async () => {
    const res = await notifyFamily(ctx);
    if (!note) return;
    if (res === 'opened') note.textContent = '已打开短信，请确认后发送。';
    else if (res === 'no-contact') {
      note.textContent = '尚未设置紧急联系人，正在前往设置…';
      setTimeout(() => ctx.navigate('#/settings'), 900);
    } else note.textContent = '无法自动打开短信，请手动联系家人。';
  });
}

export default {
  id: 'result',
  route: '#/result',
  title: '检测结果',

  render(root, ctx) {
    /* ---------------------------------------------- urgent path from intake */
    if (ctx.state.mode === 'EMERGENCY') {
      savedTimestamp = null;

      const symptoms = (ctx.state.gate?.symptoms || []).filter((s) => s !== 'none');
      const reported = symptoms.length
        ? symptoms.map((s) => SYMPTOM_LABEL[s] || s).join('、')
        : '—';

      // NO IMAGE WAS ANALYSED ON THIS PATH. The asymmetry finding (TIER_TEXT.D)
      // must not be shown here: it is an image result and there is no image.
      // Everything below is derived from the user's own answers instead.
      root.innerHTML = `
        <h1 class="screen-title tier-d">${SYMPTOM_ONLY.headline}</h1>

        <div class="card urgent-card">
          <p>根据您在基础信息中填写的症状：<b>${reported}</b></p>
          <p class="urgent-text">${SYMPTOM_ONLY.possibility}</p>
          <p class="small">${SYMPTOM_ONLY.noImage}</p>
        </div>

        <button class="btn-primary" id="continue-capture">开始面部拍摄测试</button>
        <p class="small" id="capture-note">${SYMPTOM_ONLY.suggest}${SYMPTOM_ONLY.suggestNote}</p>

        <div class="card mt">
          <b>同时请优先处理就医事项</b>
          <p class="small">以下操作可直接进行，不需要等待拍摄测试。</p>
        </div>
        ${urgentActions()}

        <button class="btn-secondary" id="fix-answers">症状填写有误，返回修改</button>
        <p class="small mt">${DISCLAIMER_SHORT}</p>
        <div class="card mt"><p class="small">${DIFFERENTIAL_REMINDER}</p></div>`;

      wireUrgentActions(root, ctx);
      // 救命提示优先，但不砍掉采集流程：用户可以选择继续拍一张
      root.querySelector('#continue-capture').addEventListener('click', () => {
        ctx.state.symptomsReported = true;
        ctx.state.mode = 'BASIC_ONLY';
        ctx.navigate('#/prep');
      });
      root.querySelector('#fix-answers').addEventListener('click', () => {
        ctx.state.mode = null;
        ctx.state.gate = null;
        ctx.state.symptomsReported = false;
        ctx.navigate('#/gate');
      });
      speak(`${SYMPTOM_ONLY.headline}。根据您填写的症状 ${reported}，`
        + '本次未进行面部图像评估。屏幕上可查看附近医院、拨打一百二十，或通知家人；'
        + '也可以继续做一次面部拍摄测试。');
      return;
    }

    /* ------------------------------------------------------ normal result */
    const res = ctx.state.lastResult;
    if (!res) {
      root.innerHTML = `
        <h1 class="screen-title">暂无检测结果</h1>
        <div class="card"><p>请先完成一次检测。</p></div>
        <button class="btn-primary" data-nav="#/gate">开始检测</button>
        <button class="btn-secondary" data-back>返回</button>`;
      return;
    }

    const t = CONFIG.thresholds;
    const tier = res.tier;
    const contact = readSettings().emergencyContact;

    root.innerHTML = `
      <h1 class="screen-title">检测结果</h1>

      <div class="card center">
        <div class="score-big">${res.score}</div>
        <p class="small">面部对称度（100 分为左右完全对称）</p>
        ${scaleBar(res.score, t || {})}
      </div>

      ${res.overlayDataUrl ? `
      <details class="landmark-panel">
        <summary>查看面部关键点分布图（478 点）</summary>
        <img class="landmark-figure" src="${res.overlayDataUrl}" alt="面部关键点分布图" />
        <p class="small">该图仅在本页显示，不写入历史记录，也不会进入报告图片。</p>
        <p class="small">下列四个区域分别取自图中的对应关键点：</p>
        ${zoneBranches(res.zones)}
      </details>` : ''}

      <div class="card">
        <b>评估依据</b>
        <p class="small">几何测量（左右镜像比对，分数越高越对称）</p>
        <table class="kv">${zoneRows(res.zones)}</table>
        ${res.nFrames ? `<p class="small">共分析 ${res.nFrames} 帧图像，帧间极差 ${Number(res.spread).toFixed(1)} 分</p>` : ''}
      </div>

      ${asymmetryBlock(res, tier)}
${ensembleBlock(res)}

      <div class="card">
        <b>评估结论</b>
        ${ctx.state.symptomsReported
          ? '<p class="small warn">您在基础信息中填报了症状，请以尽快就医为优先；以下图像评估结论仅供参考。</p>' : ''}
        <p><span class="tier-badge tier-${(tier || 'a').toLowerCase()}">${tier ? TIER_LABEL[tier] : '暂不分档'}</span></p>
        <p>${res.report?.blocks?.find((b) => b.kind === 'conclusion')?.text || ''}</p>
        ${res.palsyCapped
          ? '<p class="small">您已标记存在面神经疾病或近期面部变化，本次不按「需要留意」提示。</p>' : ''}
        ${res.report?.blocks?.filter((b) => b.kind === 'caution').map((b) => `<p class="small">${b.text}</p>`).join('') || ''}
        <p class="small">${res.previousScore === null || res.previousScore === undefined
          ? '本次为首次记录。'
          : `上次检测：${res.previousScore} 分`}</p>
      </div>

      ${tier === 'D' ? `
      <div class="card urgent-card">
        <p class="urgent-text">${TIER_TEXT.D}</p>
      </div>
      ${urgentActions()}
      ` : `
      <button class="btn-secondary" data-nav="#/algorithm">查看评估原理</button>
      <button class="btn-secondary" data-nav="#/records">历史记录</button>
      `}

      <div class="card">
        <b>动作测试</b>
        ${res.actionTest && !res.actionTest.skipped && res.actionTest.items?.length
          ? `<table class="kv">${res.actionTest.items.map((it) => `
              <tr><td>${ACTION_LABELS[it.key] || it.key}</td>
              <td>${Number.isFinite(it.percent) ? `${it.percent}%` : '未测到'}${
                Number.isFinite(it.before) ? `<span class="small">（放松时 ${it.before}%）</span>` : ''}${
                Number.isFinite(it.percent) ? '' : `<span class="small">　本次识别到 ${it.samples ?? 0} 帧</span>`}</td></tr>`).join('')}
            </table>
            <p class="small">${ACTION_TEST_NOTE}</p>`
          : `<p class="small">${actionSkipText(res.actionTest?.reason)}</p>`}
        ${res.actionCapped ? '<p class="small warn">动作测试发现两侧变化不对称，本次结论已按更谨慎的一档呈现。</p>' : ''}
      </div>

      <div class="card mt">
        <b>鉴别提示</b>
        <p class="small">${DIFFERENTIAL_REMINDER}</p>
      </div>

      <div class="card mt">
        <b>结果局限性</b>
        <p class="small">${RESULT_LIMITATION}</p>
      </div>

      ${tier === 'D' ? '' : `
      <div class="card">
        <b>日常建议</b>
        <ul class="advice-list">${(res.adviceBatch || ADVICE.slice(0, 4))
          .map((a) => `<li><b>${a.title}</b>　${a.body}</li>`).join('')}</ul>
        <details class="landmark-panel mt">
          <summary>查看全部 ${ADVICE.length} 条日常建议</summary>
          <ul class="advice-list">${ADVICE.map((a) => `<li><b>${a.title}</b>　${a.body}</li>`).join('')}</ul>
          <p class="small">建议依据：WHO、中国卒中学会、国家卫健委等公开资料。</p>
        </details>
      </div>`}

      ${res.dailyFact ? `
      <div class="card">
        <b>健康科普 · ${res.dailyFact.title}</b>
        <p class="small">${res.dailyFact.body}</p>
        <p class="small">来源：${res.dailyFact.source}</p>
      </div>` : ''}

      <p class="small center">${DISCLAIMER_SHORT}</p>
      <p class="small center" id="repeat-note"></p>

      <button class="btn-secondary" id="save-report">保存报告图片到相册</button>
      <p class="small center" id="save-note">报告图片仅含分数与分项，不含照片。</p>
      <button class="btn-secondary" id="share-report">分享报告图片给家人</button>
      <p class="small center" id="share-note">可通过微信、QQ 等应用发送；图片不含照片。</p>
      <p class="small center" id="saved-note">正在保存至历史记录…</p>
      ${contact ? '' : '<p class="small center">提示：可在「设置」中填写紧急联系人，紧急时可一键短信通知家人。</p>'}
      <button class="btn-secondary" data-back>返回</button>`;

    if (tier === 'D') wireUrgentActions(root, ctx);

    const visible = root.textContent || '';
    const hits = scanText(visible, BANNED_PATTERNS);
    if (hits.length) console.error('[FaceStroke] banned phrase on result screen:', hits);

    // the image-based urgent tier is the only place TIER_TEXT.D is rendered now,
    // so this is where the no-advice rule has to be checked at run time
    if (tier === 'D') {
      const violations = scanText(TIER_TEXT.D, ADVICE_PATTERNS);
      if (violations.length) console.error('[FaceStroke] urgent copy violates the no-advice rule', violations);
    }

    const conclusionText = res.report?.blocks?.find((b) => b.kind === 'conclusion')?.text || '';
    speak(`本次面部对称度 ${res.score} 分。`
      + (tier ? `${TIER_LABEL[tier]}。` : '本次未分档。')
      + conclusionText);

    const reportOpts = { appVersion: CONFIG.appVersion, actionTest: res.actionTest };

    root.querySelector('#save-report')?.addEventListener('click', async () => {
      const note = root.querySelector('#save-note');
      const btn = root.querySelector('#save-report');
      btn.disabled = true;
      note.textContent = '正在生成报告图片…';
      const outcome = await saveReportToGallery(res, reportOpts);
      btn.disabled = false;
      note.textContent = {
        saved: '报告图片已保存到手机相册（相册中的 FaceStroke 文件夹）。',
        unsupported: '当前环境不支持直接保存到相册，已改为下载图片。',
        denied: '未获得相册写入权限，请在手机设置中开启后重试。',
        failed: '保存失败，请稍后重试。',
      }[outcome] || '保存失败，请稍后重试。';
    });

    root.querySelector('#share-report')?.addEventListener('click', async () => {
      const note = root.querySelector('#share-note');
      const btn = root.querySelector('#share-report');
      btn.disabled = true;
      note.textContent = '正在生成报告图片…';
      const outcome = await shareReportImage(res, reportOpts);
      btn.disabled = false;
      note.textContent = {
        shared: '已打开分享面板，可选择微信、QQ 等应用发送。',
        downloaded: '当前环境不支持分享，报告图片已保存至下载目录。',
        cancelled: '已取消分享。',
        failed: '生成失败，请稍后重试。',
      }[outcome] || '分享失败，请稍后重试。';
    });

    if (savedTimestamp !== res.timestamp) {
      savedTimestamp = res.timestamp;
      addRecord({
        timestamp: res.timestamp,
        score: res.score,
        zones: res.zones,
        tier: res.tier,
        modelVersions: res.modelVersions,
        consentVersion: ctx.state.consent?.version || null,
        captureMetrics: res.captureMetrics,
      }).then(() => {
        const note = root.querySelector('#saved-note');
        if (note) note.textContent = '已保存至历史记录（仅存于本机）。';
      }).catch((err) => {
        console.error('[FaceStroke] save failed', err);
        const note = root.querySelector('#saved-note');
        if (note) note.textContent = '保存失败，但本次结果仍然有效。';
      });
    } else {
      const note = root.querySelector('#saved-note');
      if (note) note.textContent = '已保存至历史记录（仅存于本机）。';
    }

    // anti-refresh rule (03 功能规格 S7)
    (async () => {
      try {
        const all = await listRecords();
        const already = sameDayCount(all, new Date(res.timestamp));
        const count = all.some((r) => r.timestamp === res.timestamp) ? already : already + 1;
        const text = antiRefreshNote(count);
        const el = root.querySelector('#repeat-note');
        if (el && text) el.textContent = text;
      } catch (err) {
        console.warn('[FaceStroke] repeat-note failed', err);
      }
    })();
  },
};
