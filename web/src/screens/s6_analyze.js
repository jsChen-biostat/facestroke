/**
 * S6 · 分析页（过程可视化）
 * Spec: 03 功能规格 S6 / 06 §3.6 / 04 §2 / 05b §2,§5
 *
 * HONESTY RULE (03 功能规格 S6): every step performs real work and renders its
 * real artifact. `stepReadMs` is a READING dwell so an older user can actually
 * see the artifact - it is never described to the user as computation time, and
 * the real elapsed compute time for each step is measured and shown separately.
 * There is no sleep() used to simulate progress.
 *
 * Channel wiring (05b):
 *   M-Q (quality classifier) -> can veto a capture, reinforcing the quality gate
 *   M-S (symmetry regressor) -> the CNN channel, fused with the geometric score
 *
 * 2026-10-02 (seventh revision) - WHY THE PREVIOUS BUILD STALLED HERE.
 *   Device report: "it stops at 对称度计算 and then says the analysis took too
 *   long". The CNN channel ran six onnxruntime inferences inside the pipeline
 *   with no time budget at all; on a phone that can take tens of seconds, so the
 *   screen-level watchdog fired and the user lost 历史记录比对 and 评估结论
 *   entirely. The CNN channel carries weight 0 in the fusion (05b §5), so it is
 *   now run against a HARD TIME BUDGET and is abandoned the moment the budget is
 *   gone. The geometric pipeline can no longer be held up by it.
 *
 *   The watchdog is also no longer absolute: it measures time since the last
 *   step ADVANCED, so a legitimately slow step is not mistaken for a hang.
 */

import { CONFIG } from '../core/config.js';
import { detectLandmarksRobust } from '../core/landmarks.js';
import { computeGeometry, aggregateFrames, CALIBRATION } from '../core/symmetry.js';
import { predictQuality, predictSymmetryScore, loadModels, modelStatus, CNN_SKIP_TEXT } from '../core/cnn.js';
import { fuse, median, cnnHardReject } from '../core/fusion.js';
import { latestRecord } from '../core/storage.js';
import { buildReport, decideTier, zonePercent, ACTION_LABELS, ACTION_TEST_NOTE, actionSkipText } from '../core/report.js';
import { readSettings } from '../core/settings.js';
import { applyPalsyOverride, applyActionTest } from '../core/policy.js';
import { speak } from '../core/tts.js';
import { pickDailyFact, pickAdviceBatch } from '../core/knowledge.js';
import { predictAsymmetry } from '../core/asymmetryModel.js';
import { predictStrokeEnsemble } from '../core/strokeEnsemble.js';

const STEPS = [
  { key: 'quality', label: '图像质量校验', caption: '正在校验图像质量' },
  { key: 'landmarks', label: '面部关键点定位', caption: '正在定位面部 478 个关键点' },
  { key: 'symmetry', label: '对称度计算', caption: '正在计算左右对称度' },
  { key: 'history', label: '历史记录比对', caption: '正在比对历史记录' },
  { key: 'advice', label: '生成评估结论', caption: '正在生成评估结论' },
];

const OVERLAY_W = 320;

/**
 * The CNN channel is a CROSS-CHECK with weight 0 in the fusion (05b §5), so it
 * gets a hard budget and is dropped when the budget runs out. Without this the
 * geometric result never reached the screen on a slow phone.
 */
const CNN_TOTAL_BUDGET_MS = 8000;
const CNN_CALL_TIMEOUT_MS = 3000;
/** Loading happens on the capture screen, so this only has to cover the tail. */
const CNN_LOAD_TIMEOUT_MS = 6000;

/** Bail only when NO step has advanced for this long - a slow step is not a hang. */
const STALL_TIMEOUT_MS = 25000;

const readDwell = (ms) => new Promise((r) => { setTimeout(r, ms); });

function withTimeout(promise, ms, tag) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${tag}-timeout`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

/**
 * The scan view: the captured frame with a sweeping scan line, and the real
 * landmark dots appearing as soon as detection has run. Nothing here is
 * decorative padding - the dots are the detected points.
 */
function createScanView(bitmap) {
  const scale = OVERLAY_W / bitmap.width;
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = OVERLAY_W;
  canvas.height = h;
  const c = canvas.getContext('2d');
  let landmarks = null;
  let alive = true;
  let raf = null;
  const started = performance.now();

  const dots = (ctx2d, lm) => {
    if (!lm) return;
    ctx2d.fillStyle = 'rgba(255,86,86,0.92)';
    for (const p of lm) {
      ctx2d.beginPath();
      ctx2d.arc(p.x * OVERLAY_W, p.y * h, 1.7, 0, Math.PI * 2);
      ctx2d.fill();
    }
  };

  const draw = () => {
    if (!alive) return;
    c.drawImage(bitmap, 0, 0, OVERLAY_W, h);
    if (!landmarks) {
      const y = ((performance.now() - started) / 1500 % 1) * h;
      const grad = c.createLinearGradient(0, y - 30, 0, y + 30);
      grad.addColorStop(0, 'rgba(90,200,255,0)');
      grad.addColorStop(0.5, 'rgba(90,200,255,0.40)');
      grad.addColorStop(1, 'rgba(90,200,255,0)');
      c.fillStyle = grad;
      c.fillRect(0, y - 30, OVERLAY_W, 60);
      c.fillStyle = 'rgba(140,225,255,0.95)';
      c.fillRect(0, y, OVERLAY_W, 2);
    } else {
      dots(c, landmarks);
    }
    raf = requestAnimationFrame(draw);
  };
  draw();

  return {
    canvas,
    setLandmarks(lm) { landmarks = lm; },
    /** Freeze a still WITHOUT the scan line, for the result screen. */
    snapshot() {
      const out = document.createElement('canvas');
      out.width = OVERLAY_W;
      out.height = h;
      const oc = out.getContext('2d');
      oc.drawImage(bitmap, 0, 0, OVERLAY_W, h);
      dots(oc, landmarks);
      return out;
    },
    stop() {
      alive = false;
      if (raf) cancelAnimationFrame(raf);
      raf = null;
    },
  };
}

export default {
  id: 'analyze',
  route: '#/analyze',
  title: '正在分析',

  render(root, ctx) {
    const frames = ctx.state.lastFrames?.frames || [];
    const metrics = ctx.state.lastFrames?.metrics || [];

    root.innerHTML = `
      <h1 class="screen-title">正在分析</h1>
      <div class="scan-wrap" id="scan-wrap"></div>
      <div class="progress"><div class="progress-fill" id="progress-fill"></div></div>
      <p class="progress-caption" id="caption">正在准备分析…</p>
      <div id="steps" class="card"></div>
      <div id="artifact"></div>
      <p class="small" id="timing"></p>`;

    const scanWrap = root.querySelector('#scan-wrap');
    const fillEl = root.querySelector('#progress-fill');
    const captionEl = root.querySelector('#caption');
    const stepsEl = root.querySelector('#steps');
    const artifactEl = root.querySelector('#artifact');
    const timingEl = root.querySelector('#timing');

    let scan = null;
    if (frames.length) {
      scan = createScanView(frames[0]);
      const inner = scan.canvas;
      inner.style.width = '100%';
      inner.style.display = 'block';
      inner.style.borderRadius = '12px';
      // the capture preview is mirrored, like a mirror; mirror the scan too
      inner.style.transform = 'scaleX(-1)';
      scanWrap.appendChild(inner);
    }

    let lastProgressAt = performance.now();

    const setProgress = (idx, caption) => {
      const pct = Math.round((idx / STEPS.length) * 100);
      fillEl.style.width = `${pct}%`;
      if (caption) captionEl.textContent = caption;
    };

    const mark = (idx, state, computeMs) => {
      lastProgressAt = performance.now();
      stepsEl.innerHTML = STEPS.map((s, i) => {
        let suffix = '';
        if (i < idx || (i === idx && state === 'done')) suffix = ' ✓';
        else if (i === idx) suffix = ' …';
        const t = (i === idx && Number.isFinite(computeMs)) ? ` <span class="small">(${computeMs} ms)</span>` : '';
        return `<p data-step="${s.key}">${i + 1}. ${s.label}${suffix}${t}</p>`;
      }).join('');
      setProgress(idx, STEPS[idx]?.caption);
    };

    const bail = (message) => {
      aborted = true;
      clearInterval(watchdog);
      if (scan) scan.stop();
      artifactEl.innerHTML = `<div class="card"><p>${message}</p></div>`;
      artifactEl.insertAdjacentHTML('beforeend',
        '<button class="btn-primary" data-nav="#/capture">重新采集</button>'
        + '<button class="btn-secondary" data-back>返回</button>');
      fillEl.style.width = '100%';
      captionEl.textContent = '已停止';
      for (const f of frames) { try { f.close?.(); } catch { /* released */ } }
      ctx.state.lastFrames = null;
    };

    let aborted = false;
    const guard = () => aborted;

    // Stall watchdog: fires only when no step has advanced for a long time, so a
    // legitimately slow step is never mistaken for a hang.
    const watchdog = setInterval(() => {
      if (aborted) return;
      if (performance.now() - lastProgressAt > STALL_TIMEOUT_MS) {
        clearInterval(watchdog);
        bail('分析在某一步停留过久，已停止。请重新采集一次。');
      }
    }, 1000);

    (async () => {
      const measured = {};
      const t0 = performance.now();
      speak('正在分析，请稍等。');
      captionEl.textContent = '正在准备 AI 辅助通道…';

      // ---- CNN budget: the channel may use at most CNN_TOTAL_BUDGET_MS in total
      const cnnDeadline = performance.now() + CNN_TOTAL_BUDGET_MS;
      const cnnCall = async (fn, arg) => {
        const left = cnnDeadline - performance.now();
        if (left < 300) return null;
        try {
          return await withTimeout(fn(arg), Math.min(CNN_CALL_TIMEOUT_MS, left), 'cnn');
        } catch (err) {
          console.warn('[FaceStroke] CNN call exceeded its budget, skipping', err);
          return null;
        }
      };

      let cnnAvailable = false;
      let cnnSkip = 'ok';
      try {
        // the capture screen preloads this, so it is normally already resolved
        cnnAvailable = await withTimeout(loadModels(), CNN_LOAD_TIMEOUT_MS, 'cnn-load');
        if (!cnnAvailable) cnnSkip = 'load-failed';
      } catch (err) {
        console.warn('[FaceStroke] CNN channel unavailable, continuing without it', err);
        cnnSkip = 'load-timeout';
      }
      const cnnStatus = modelStatus();
      lastProgressAt = performance.now();
      if (guard()) return;

      // ---------------------------------------------------------- 1 quality
      let t = performance.now();
      mark(0, 'busy');
      if (!frames.length) { bail('没有可用的图像，请重新采集。'); return; }

      const geoLines = metrics.map((m, i) =>
        `第 ${i + 1} 张：清晰度 ${Math.round(m.sharpness)} · 偏航 ${m.yawProxy.toFixed(3)} · 亮度 ${Math.round(m.brightness)}`);

      const qResults = [];
      if (cnnAvailable) {
        for (const f of frames) {
          // eslint-disable-next-line no-await-in-loop
          qResults.push(await cnnCall(predictQuality, f));
          lastProgressAt = performance.now();
        }
      }
      const vetoes = qResults.filter((q) => cnnHardReject(q, CONFIG.quality));
      const qLines = qResults.filter(Boolean).map((q, i) =>
        `第 ${i + 1} 帧质量判别：${q.label}（置信度 ${(q.confidence * 100).toFixed(0)}%）`);

      artifactEl.innerHTML = `
        <div class="card">
          <span class="q-title">图像质量（${frames.length} 帧已通过校验）</span>
          <p class="small">${geoLines.join('<br>')}</p>
          ${qLines.length ? `<p class="small">${qLines.join('<br>')}</p>` : ''}
        </div>`;
      measured.quality = Math.round(performance.now() - t);

      // RED LINE: a frame the quality model is confident is unusable must not score
      if (vetoes.length && vetoes.length >= Math.ceil(frames.length / 2)) {
        bail(`本次采集的图像未通过质量校验（${vetoes[0].label}），请重新采集。`);
        return;
      }
      mark(0, 'done', measured.quality);
      await readDwell(CONFIG.pacing.stepReadMs);
      if (guard()) return;

      // -------------------------------------------------------- 2 landmarks
      t = performance.now();
      mark(1, 'busy');
      captionEl.textContent = '正在定位面部 478 个关键点';
      const landmarkSets = [];
      let modelFailed = false;
      for (const f of frames) {
        // robust detection: retries rotated, in case the frame is "lying down"
        // eslint-disable-next-line no-await-in-loop
        const { landmarks, modelError } = await detectLandmarksRobust(f);
        if (modelError) modelFailed = true;
        if (landmarks) landmarkSets.push(landmarks);
        lastProgressAt = performance.now();
      }
      if (!landmarkSets.length) {
        // a model that never loaded must not be reported as "no face in the photo"
        bail(modelFailed
          ? '面部识别模型未能加载，无法完成定位。请返回采集页重新加载模型。'
          : '未能定位到面部，请重新采集。');
        return;
      }
      // the real points appear on the scan view the moment they exist
      if (scan) scan.setLandmarks(landmarkSets[0]);

      // 面部不对称模型（初版）：输入是**几何特征**，不是像素。
      // 用几何特征是为了绕开"格式/锐度/饱和度"这类与病理无关的捷径：
      // 纯像素 + 纯颜色的分类器在这份数据上 AUC 可达 0.999，几何特征压到 0.778。
      // 纯 JS 推理，不需要 ONNX Runtime。
      let asymmetryModel = null;
      try {
        asymmetryModel = await predictAsymmetry(landmarkSets[0]);
      } catch (err) {
        console.warn('[FaceStroke] 不对称模型未能运行', err);
      }

      // 四网络集成（与文献同一套框架）：人脸对齐裁剪 → 四个骨干 → sigmoid → 取平均
      let strokeEnsemble = null;
      try {
        if (CONFIG.strokeEnsemble?.enabled) {
          const srcFrame = frames[0];
          strokeEnsemble = await predictStrokeEnsemble(srcFrame, landmarkSets[0]);
        }
      } catch (err) {
        console.warn('[FaceStroke] 四网络推理未能运行', err);
      }

      measured.landmarks = Math.round(performance.now() - t);
      mark(1, 'done', measured.landmarks);
      await readDwell(CONFIG.pacing.stepReadMs);
      if (guard()) return;

      // --------------------------------------------------------- 3 symmetry
      t = performance.now();
      mark(2, 'busy');
      const perFrame = landmarkSets.map((lm) => computeGeometry(lm, {
        aRef: CALIBRATION.aRef,
        aMax: CALIBRATION.aMax,
      })).filter(Boolean);
      const agg = aggregateFrames(perFrame);
      if (!agg) { bail('无法完成测量，请重新采集。'); return; }
      lastProgressAt = performance.now();

      // CNN cross-check on the same frames, still inside the shared budget
      let cnnScores = [];
      if (cnnAvailable) {
        captionEl.textContent = 'AI 通道交叉校验中';
        for (const f of frames) {
          // eslint-disable-next-line no-await-in-loop
          cnnScores.push(await cnnCall(predictSymmetryScore, f));
          lastProgressAt = performance.now();
        }
      }
      cnnScores = cnnScores.filter((v) => Number.isFinite(v));
      const cnnScore = median(cnnScores);
      if (cnnAvailable && cnnScore === null) {
        cnnSkip = cnnScores.length === 0 ? 'budget' : 'no-score';
      }
      const fusion = fuse(agg.score, cnnScore, CONFIG.weights, CONFIG.fusionConflictGap);

      const zones = {};
      for (const [z, v] of Object.entries(agg.zones)) {
        zones[z] = { asymmetry: v, percent: zonePercent(v, CALIBRATION.aRef, CALIBRATION.aMax) };
      }
      const zoneRows = Object.entries(zones)
        .filter(([z]) => ['forehead', 'eyelid', 'nasolabial', 'mouth'].includes(z))
        .map(([z, v]) => `${z}：${v.percent === null ? '—' : `${v.percent}%`}`)
        .join(' · ');

      artifactEl.insertAdjacentHTML('beforeend', `
        <div class="card">
          <span class="q-title">本次对称度 ${fusion.score} 分</span>
          <p class="small">几何通道：${agg.score} 分（${agg.nFrames} 帧，帧间极差 ${agg.spread.toFixed(1)}）</p>
          <p class="small">AI 通道：${cnnScore === null
            ? `本次未参与${CNN_SKIP_TEXT[cnnSkip] || ''}`
            : `交叉校验 ${cnnScore} 分${CNN_SKIP_TEXT[cnnSkip] || ''}`}${fusion.conflict ? ' · 两通道结果差异较大' : ''}</p>
          <p class="small">分区不对称度：${zoneRows}</p>
        </div>`);
      measured.symmetry = Math.round(performance.now() - t);
      mark(2, 'done', measured.symmetry);

      // guided action test: real measured values, or an explicit "not done"
      const actionTest = ctx.state.actionTest || { skipped: true, reason: 'unknown' };
      if (!actionTest.skipped && actionTest.items?.length) {
        const rows = actionTest.items.map((it) => `${ACTION_LABELS[it.key] || it.key}：`
          + `${Number.isFinite(it.percent) ? `${it.percent}%` : '未测到'}`);
        artifactEl.insertAdjacentHTML('beforeend', `
          <div class="card">
            <span class="q-title">动作测试（${actionTest.items.length} 项）</span>
            <p class="small">${rows.join(' · ')}</p>
            <p class="small">${ACTION_TEST_NOTE}</p>
          </div>`);
      } else {
        artifactEl.insertAdjacentHTML('beforeend', `
          <div class="card">
            <span class="q-title">动作测试</span>
            <p class="small">${actionSkipText(actionTest.reason)}</p>
          </div>`);
      }

      await readDwell(CONFIG.pacing.stepReadMs);
      if (guard()) return;

      // ---------------------------------------------------------- 4 history
      t = performance.now();
      mark(3, 'busy');
      let previous = null;
      try {
        previous = await latestRecord();
      } catch (err) {
        console.warn('[FaceStroke] history read failed', err);
      }
      artifactEl.insertAdjacentHTML('beforeend', `
        <div class="card">
          <span class="q-title">历史记录比对</span>
          <p class="small">${previous
            ? `上次（${(previous.timestamp || '').slice(0, 10)}）为 ${previous.score} 分`
            : '这是您的第一次记录，暂无历史可比。'}</p>
        </div>`);
      measured.history = Math.round(performance.now() - t);
      mark(3, 'done', measured.history);
      await readDwell(CONFIG.pacing.stepReadMs);
      if (guard()) return;

      // ----------------------------------------------------------- 5 advice
      t = performance.now();
      mark(4, 'busy');
      const hasCnn = fusion.cnnUsed;
      const decided = decideTier(fusion.score, CONFIG.thresholds);
      const ambiguous = decided.ambiguous || fusion.conflict;
      // 02 §5: a declared palsy / recent facial change withholds the alarm tier
      const palsy = applyPalsyOverride(decided.tier, readSettings().palsy);
      // the guided action test may only ever make the result MORE cautious
      const action = applyActionTest(palsy.tier, actionTest, readSettings().palsy);
      const report = buildReport({
        score: fusion.score,
        zones,
        tier: action.tier,
        previousScore: previous ? previous.score : null,
        ambiguous,
        hasCnn,
        actionTest,
      });
      if (palsy.capped && palsy.note) {
        report.blocks.splice(1, 0, { kind: 'caution', text: palsy.note });
      }
      if (action.capped && action.note) {
        report.blocks.splice(1, 0, { kind: 'caution', text: action.note });
      }
      if (fusion.conflict) {
        report.blocks.splice(1, 0, {
          kind: 'caution',
          text: '几何测量与 AI 通道的结果差异较大，本次结论仅供参考。',
        });
      }
      artifactEl.insertAdjacentHTML('beforeend', `
        <div class="card">
          <span class="q-title">评估结论</span>
          <p class="small">${report.blocks.map((b) => b.text).join(' ')}</p>
        </div>`);
      measured.advice = Math.round(performance.now() - t);

      // freeze the landmark still BEFORE the frames are released
      let overlayDataUrl = null;
      if (scan) {
        try {
          overlayDataUrl = scan.snapshot().toDataURL('image/png');
        } catch (err) {
          console.warn('[FaceStroke] could not freeze the landmark view', err);
        }
        scan.stop();
      }

      ctx.state.lastResult = {
        score: fusion.score,
        geoScore: agg.score,
        cnnScore,
        cnnSkip,
        cnnStatus,
        fusion,
        zones,
        tier: action.tier,
        tierBeforePalsy: decided.tier,
        palsyCapped: palsy.capped,
        actionCapped: action.capped,
        actionTest,
        ambiguous,
        spread: agg.spread,
        nFrames: agg.nFrames,
        previousScore: previous ? previous.score : null,
        report,
        quality: qResults,
        captureMetrics: metrics,
        // in-memory only: never written to the record store, never in the report
        landmarks: landmarkSets[0],
        asymmetryModel,
        strokeEnsemble,
        overlayDataUrl,
        // rotated: a different explainer on every capture, plus a slice of advice
        dailyFact: pickDailyFact(),
        adviceBatch: pickAdviceBatch(4),
        modelVersions: {
          geo: CONFIG.fingerprints.geo,
          cnn: CONFIG.fingerprints.cnn,
          fusion: CONFIG.fingerprints.fusion,
          copy: CONFIG.fingerprints.copy,
        },
        timestamp: new Date().toISOString(),
      };

      for (const f of frames) {
        try {
          f.close?.();
        } catch { /* already released */ }
      }
      ctx.state.lastFrames = null;

      mark(4, 'done', measured.advice);
      mark(5, 'done');
      setProgress(STEPS.length, '分析完成');
      const total = Math.round(performance.now() - t0);
      timingEl.textContent =
        `各步实际计算耗时：质量 ${measured.quality}ms · 关键点 ${measured.landmarks}ms · `
        + `对称度 ${measured.symmetry}ms · 历史 ${measured.history}ms · 结论 ${measured.advice}ms；`
        + `合计 ${total}ms（其余时间为每步结果的阅读停留）。`;

      await readDwell(CONFIG.pacing.stepReadMs);
      if (guard()) return;
      clearInterval(watchdog);
      ctx.navigate('#/result');
    })();

    this._abort = () => { aborted = true; clearInterval(watchdog); if (scan) scan.stop(); };
  },

  destroy() {
    if (this._abort) this._abort();
  },
};
