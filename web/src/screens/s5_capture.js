/**
 * S5 · 面部采集
 * Spec: 03 功能规格 S5 / 02 §5 防线二 / 06 §3.5
 *
 * 2026-10-02 fourth revision. Device test 3 reported two faults:
 *   "the capture area is just black"  and  "the shoot button does nothing".
 *
 * WHY IT WAS BLACK
 *   The third revision awaited the model warm-up BEFORE starting the camera:
 *
 *       const status = await warmUpStatus();   // two MediaPipe models
 *       await startPreview();                  // only now does the camera open
 *
 *   Loading two FaceLandmarker instances on a phone takes a long time and can
 *   hang, so the preview never started and the user stared at a black rectangle
 *   for as long as it lasted. The camera now opens FIRST and the models load in
 *   parallel, and a preview that produces no frame within
 *   PREVIEW_START_TIMEOUT_MS no longer leaves a black area: the screen switches
 *   itself to photo mode and says why.
 *
 * WHY THE BUTTON DID NOTHING
 *   The old shoot() treated every non-photo outcome as "the user cancelled",
 *   including "the native plugin is not there" and "permission denied", and it
 *   never fell back to the file input. So the tap really could produce nothing
 *   at all. Every outcome is now visible, and there is always a working fallback.
 *
 * Also in this revision: a failed model load is no longer cached forever (which
 * made the retry button useless), and a model failure is never reported as
 * "no face detected".
 */

import { CONFIG } from '../core/config.js';
import {
  detectForVideo, detectLandmarksRobust, blobToBitmap, warmUpStatus, resetModels, assetInfo,
} from '../core/landmarks.js';
import { computeGeometry, CALIBRATION } from '../core/symmetry.js';
import { zonePercent, isNotableZone } from '../core/report.js';
import { cueStart, cueActionDone, cueAllDone, primeFeedback } from '../core/feedback.js';
import { loadModels as loadCnnModels } from '../core/cnn.js';
import {
  takePhoto, pickPhoto, isNative, prepareCamera, nativeReady,
} from '../core/camera.js';
import { guideOnce, resetGuidance, speak } from '../core/tts.js';
import {
  REASON, LAMP_LABEL,
  luminanceStats, laplacianVariance, yawProxyOf, faceWidthRatioOf,
  mouthFlatnessRatio, assessFrame, primaryInstruction, pickBestFrames,
} from '../core/quality.js';

const ANALYSIS_W = 320;
const ANALYSIS_H = 240;
const CAPTURE_W = 640;
const CAPTURE_H = 480;

// live-loop pacing
const DETECT_INTERVAL_MS = 150;
const IMAGE_FALLBACK_EVERY_MS = 2500;
const STABLE_MS = 1200;
const NO_FACE_TROUBLESHOOT_MS = 6000;

/**
 * Guided action test (device test 5: the three action prompts used to be text
 * that nothing checked). Each action is now performed in front of the live
 * camera and actually measured, so the prompts change the result.
 */
const ACTIONS = [
  { key: 'brow', zone: 'forehead', prompt: '请抬起眉毛', hint: '请抬起眉毛并保持住' },
  { key: 'smile', zone: 'mouth', prompt: '请露齿微笑', hint: '请露齿微笑并保持住' },
  { key: 'eyes', zone: 'eyelid', prompt: '请用力闭眼', hint: '请用力闭眼并保持住' },
];
const ACTION_BASELINE_MS = 1200;
const ACTION_SETTLE_MS = 700;
const ACTION_MS = 1900;
const ACTION_INTERVAL_MS = 300;

/** Minimum frames a single action must yield before its number is reported. */
const ACTION_MIN_SAMPLES = 2;

// watchdogs: no step is allowed to hang the screen without saying so
const PREVIEW_START_TIMEOUT_MS = 4500;
const PREVIEW_POLL_MS = 400;
const MODEL_TIMEOUT_MS = 45000;
const STILL_TIMEOUT_MS = 15000;

let teardown = null;

const TROUBLESHOOT = '未能识别到面部。请尝试：靠近一些、摘掉口罩与帽子、'
  + '换到光线明亮处正对镜头；也可以点下方按钮用手机相机拍摄。';

const MODEL_FAIL_BODY = '模型文件随应用安装，不需要联网。请点下方按钮重新加载；'
  + '若多次失败，请把下方这行错误信息一并告知我们。';

function withTimeout(promise, ms, tag) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${tag}-timeout`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

export default {
  id: 'capture',
  route: '#/capture',
  title: '面部采集',

  render(root, ctx) {
    resetGuidance();
    const secure = window.isSecureContext
      || location.hostname === 'localhost'
      || location.hostname === '127.0.0.1';
    const liveSupported = !!navigator.mediaDevices?.getUserMedia && secure;

    root.innerHTML = `
      <h1 class="screen-title" id="capture-title">面部采集</h1>

      <div class="capture-wrap" id="live-panel" ${liveSupported ? '' : 'hidden'}>
        <video id="cam" playsinline muted autoplay></video>
        <div class="guide-ring"></div>
        <div class="lamps" id="lamps">
          ${Object.entries(LAMP_LABEL).map(([k, label]) => `
            <span class="lamp" data-lamp="${k}"><i></i>${label}</span>`).join('')}
        </div>
        <div class="countdown hidden" id="countdown"></div>
        <div class="action-prompt hidden" id="action-prompt">
          <p id="action-prompt-text"></p>
          <button class="btn-secondary" id="action-skip">跳过动作测试</button>
        </div>
        <div class="preview-status" id="preview-status">
          <p id="preview-status-text">正在启动实时预览…</p>
        </div>
      </div>

      <p class="hint-line" id="hint"></p>

      <div class="card" id="notice" hidden>
        <span class="q-title" id="notice-title"></span>
        <p class="small" id="notice-body"></p>
        <p class="small mono" id="notice-detail" hidden></p>
        <button class="btn-secondary" id="notice-retry" hidden>重新加载模型</button>
        <button class="btn-secondary" id="notice-fallback" hidden>改用系统选择器</button>
      </div>

      <div class="card" id="photo-mode" hidden>
        <span class="q-title" id="photo-mode-title"></span>
        <p class="small" id="photo-mode-body"></p>
      </div>

      <button class="btn-primary" id="shoot">使用手机相机拍摄</button>
      <button class="btn-secondary" id="pick">从相册选择</button>

      <input id="still-input" type="file" accept="image/*" capture="user" hidden />
      <input id="gallery-input" type="file" accept="image/*" hidden />
      <canvas id="work" width="${ANALYSIS_W}" height="${ANALYSIS_H}" class="hidden"></canvas>
      <canvas id="shot" width="${CAPTURE_W}" height="${CAPTURE_H}" class="hidden"></canvas>

      <button class="btn-secondary" data-back>返回</button>`;

    const video = root.querySelector('#cam');
    const lampsEl = root.querySelector('#lamps');
    const hintEl = root.querySelector('#hint');
    const countdownEl = root.querySelector('#countdown');
    const actionPrompt = root.querySelector('#action-prompt');
    const actionPromptText = root.querySelector('#action-prompt-text');
    const livePanel = root.querySelector('#live-panel');
    const previewStatus = root.querySelector('#preview-status');
    const previewStatusText = root.querySelector('#preview-status-text');
    const notice = root.querySelector('#notice');
    const noticeTitle = root.querySelector('#notice-title');
    const noticeBody = root.querySelector('#notice-body');
    const noticeRetry = root.querySelector('#notice-retry');
    const noticeFallback = root.querySelector('#notice-fallback');
    const noticeDetail = root.querySelector('#notice-detail');
    const photoMode = root.querySelector('#photo-mode');
    const photoModeTitle = root.querySelector('#photo-mode-title');
    const photoModeBody = root.querySelector('#photo-mode-body');
    const shootBtn = root.querySelector('#shoot');
    const pickBtn = root.querySelector('#pick');
    const work = root.querySelector('#work');
    const shot = root.querySelector('#shot');
    const workCtx = work.getContext('2d', { willReadFrequently: true });
    const shotCtx = shot.getContext('2d');

    let stream = null;
    let rafId = null;
    let running = true;
    let lastDetect = 0;
    let lastImageFallback = 0;
    let stableSince = 0;
    let noFaceSince = 0;
    let capturing = false;
    let busy = false;
    let lastMetrics = null;
    let lastFaces = [];
    let photoOnly = false;
    let liveReady = false;
    let skipActionTest = false;
    let fallbackInput = '#still-input';
    const timers = [];
    const diag = [];

    /** A short in-memory trail shown in the long-press panel. Users never see it. */
    const note = (msg) => {
      diag.push(msg);
      if (diag.length > 10) diag.shift();
    };

    const setLamps = (lamps) => {
      for (const el of lampsEl.querySelectorAll('[data-lamp]')) {
        el.classList.toggle('on', lamps[el.getAttribute('data-lamp')] === true);
      }
    };

    const setHint = (text, warn = false) => {
      hintEl.textContent = text;
      hintEl.classList.toggle('warn', warn);
      guideOnce('capture-hint', text, 5000);
    };

    const showNotice = (title, body, opts = {}) => {
      notice.hidden = false;
      noticeTitle.textContent = title;
      noticeBody.textContent = body;
      noticeRetry.hidden = !opts.retry;
      noticeFallback.hidden = !opts.fallback;
      noticeDetail.hidden = !opts.detail;
      if (opts.detail) noticeDetail.textContent = opts.detail;
    };

    /**
     * A failing model load is the one case where the raw reason has to reach the
     * screen: without it a device-specific failure is indistinguishable from
     * "your face was not found", which is exactly the confusion we shipped twice.
     */
    const describeModelFailure = (s) => {
      const files = (s?.files || [])
        .map((f) => `${f.name}=${f.status}${f.bytes ? `/${f.bytes}B` : ''}${f.type ? `/${f.type}` : ''}`)
        .join(' ');
      return `错误信息（反馈时请一并告知）：${s?.detail || '未知'}`
        + ` · 环节=${s?.error || '未知'}`
        + ` · 方式=${s?.strategy || '未知'}`
        + (files ? ` · 文件 ${files}` : '');
    };

    let lastModelStatus = null;

    const loadModels = async () => {
      const status = await warmUpStatus({ timeoutMs: MODEL_TIMEOUT_MS });
      lastModelStatus = status;
      if (status.ok) {
        note(`识别模型已就绪（${status.strategy || '已加载'}）`);
        return true;
      }
      note(`模型加载失败：${status.error || 'unknown'} ${status.detail || ''}`);
      showNotice('面部识别模型未能加载', MODEL_FAIL_BODY,
        { retry: true, detail: describeModelFailure(status) });
      setHint('面部识别模型未能加载。', true);
      console.error('[FaceStroke] model load failed:', status.error, status.detail, status.files);
      return false;
    };

    const showModelNotice = () => {
      showNotice('面部识别模型未能加载', MODEL_FAIL_BODY,
        { retry: true, detail: describeModelFailure(lastModelStatus) });
      setHint('面部识别模型未能加载。', true);
    };

    const setBtnBusy = (btn, isBusy, busyLabel) => {
      if (!btn) return;
      btn.disabled = isBusy;
      btn.classList.toggle('btn-busy', isBusy);
      if (isBusy) {
        if (!btn.dataset.label) btn.dataset.label = btn.textContent;
        btn.textContent = busyLabel;
      } else if (btn.dataset.label) {
        btn.textContent = btn.dataset.label;
      }
    };

    /** Never leave a black rectangle: say what happened and what to do instead. */
    const showPhotoMode = (reason) => {
      photoMode.hidden = false;
      photoModeTitle.textContent = '请使用手机相机拍摄';
      photoModeBody.textContent = `${reason}请点下方按钮用手机相机拍摄一张正脸照片，`
        + '或从相册选择一张。两种方式与实时预览使用同一套分析，结果一致。';
    };

    const markPreviewLive = () => {
      liveReady = true;
      previewStatus.hidden = true;
    };

    const degradeToPhotoMode = (reason) => {
      if (photoOnly) return;
      photoOnly = true;
      liveReady = false;
      stopCamera();
      livePanel.hidden = true;
      showPhotoMode(reason);
      note(`切换到拍照模式：${reason}`);
    };

    /* --------------------------------------------------------- live preview */

    /** Start (or restart) the live preview. Safe to call repeatedly. */
    const startPreview = async () => {
      if (!liveSupported || photoOnly) return;
      try {
        if (!stream) {
          previewStatusText.textContent = '正在启动实时预览…';
          previewStatus.hidden = false;
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false,
          });
          if (photoOnly) {
            // the watchdog already gave up on the preview while we were waiting
            for (const t of stream.getTracks()) t.stop();
            stream = null;
            return;
          }
          video.srcObject = stream;
          note('摄像头已连接');
        }
        if (video.paused) await video.play();
        if (video.videoWidth > 0) markPreviewLive();
        if (!rafId) {
          running = true;
          noFaceSince = performance.now();
          loop();
        }
      } catch (err) {
        console.error('[FaceStroke] camera failed', err);
        const name = err?.name || '未知错误';
        note(`getUserMedia 失败：${name}`);
        degradeToPhotoMode(name === 'NotAllowedError'
          ? '未获得摄像头权限。'
          : `实时预览不可用（${name}）。`);
        setHint('请使用手机相机拍摄一张正脸照片。', true);
      }
    };

    function stopCamera() {
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = null;
      if (stream) {
        for (const t of stream.getTracks()) t.stop();
        stream = null;
      }
    }

    /**
     * Watch the preview start-up. A stream that never delivers a frame (a dropped
     * permission prompt, a camera another app is holding) used to freeze the panel
     * on black forever.
     */
    const watchPreview = () => {
      const started = performance.now();
      const iv = setInterval(() => {
        if (video.videoWidth > 0 && video.readyState >= 2) {
          clearInterval(iv);
          markPreviewLive();
          return;
        }
        if (performance.now() - started > PREVIEW_START_TIMEOUT_MS) {
          clearInterval(iv);
          degradeToPhotoMode('实时预览未能在数秒内启动。');
          setHint('实时预览未启动，请用手机相机拍摄。', true);
        }
      }, PREVIEW_POLL_MS);
      timers.push(iv);
    };

    /* -------------------------------------------------------- still capture */

    /** Quality of one still, using the same gate as the live path. */
    const assessStill = async (bitmap) => {
      workCtx.drawImage(bitmap, 0, 0, ANALYSIS_W, ANALYSIS_H);
      const rgba = workCtx.getImageData(0, 0, ANALYSIS_W, ANALYSIS_H).data;
      const lum = luminanceStats(rgba);
      const { landmarks: lm, rotation, modelError } = await detectLandmarksRobust(bitmap);
      const metrics = {
        faceFound: !!lm,
        faceCount: lm ? 1 : 0,
        brightness: lum.mean,
        brightnessP5: lum.p5,
        brightnessP95: lum.p95,
        sharpness: laplacianVariance(rgba, ANALYSIS_W, ANALYSIS_H),
        yawProxy: lm ? yawProxyOf(lm) : Infinity,
        faceWidthRatio: lm ? faceWidthRatioOf(lm) : 0,
        mouthFlatness: lm ? mouthFlatnessRatio(lm, rgba, ANALYSIS_W, ANALYSIS_H) : null,
      };
      return { metrics, verdict: assessFrame(metrics, CONFIG.quality), rotation, modelError };
    };

    const acceptStill = async (bitmap, metrics, source) => {
      const canvas = document.createElement('canvas');
      canvas.width = CAPTURE_W;
      canvas.height = CAPTURE_H;
      canvas.getContext('2d').drawImage(bitmap, 0, 0, CAPTURE_W, CAPTURE_H);
      const stored = await createImageBitmap(canvas);
      try { bitmap.close?.(); } catch { /* already released */ }
      ctx.state.lastFrames = {
        frames: [stored],
        metrics: [{
          sharpness: metrics.sharpness,
          yawProxy: Number.isFinite(metrics.yawProxy) ? metrics.yawProxy : 1,
          brightness: metrics.brightness,
        }],
        capturedAt: new Date().toISOString(),
        source: 'system-camera',
      };
      note(`照片已接受（${source}）`);
      // a single photo cannot show how the two sides MOVE, so the guided action
      // test is genuinely unavailable on this path - and the result says so
      ctx.state.actionTest = { skipped: true, reason: 'still-path' };
      setHint('照片已就绪，正在进入分析…');
      ctx.navigate('#/analyze');
    };

    const handleBlob = async (blob) => {
      if (!blob) return;
      busy = true;
      setHint('正在检查照片质量…');
      try {
        const bitmap = await blobToBitmap(blob);
        const { metrics, verdict, rotation, modelError } = await withTimeout(
          assessStill(bitmap), STILL_TIMEOUT_MS, 'still',
        );
        if (rotation) note(`照片旋转 ${rotation} 度后识别到面部`);
        if (!verdict.passed) {
          bitmap.close?.();
          if (modelError) { showModelNotice(); return; }
          setHint(`照片未通过质量校验：${primaryInstruction(verdict.reasons)}`, true);
          if (verdict.reasons.includes(REASON.NO_FACE)) {
            showNotice('未在这张照片中找到面部', TROUBLESHOOT, {});
          }
          return;
        }
        await acceptStill(bitmap, metrics, 'still');
      } catch (err) {
        console.error('[FaceStroke] still capture failed', err);
        setHint(/timeout/.test(String(err?.message || ''))
          ? '照片处理超时，请重新拍摄或从相册选择一张。'
          : '无法读取这张照片，请重新拍摄。', true);
      } finally {
        busy = false;
        startPreview(); // the picker paused the WebView; bring the preview back
      }
    };

    /**
     * Get one still from the chosen channel.
     *
     * The file-input fallback is clicked SYNCHRONOUSLY when we already know the
     * native plugin is absent, because the picker needs the user-gesture context
     * that an await would destroy. When the native call fails at run time we show
     * a notice with its own button, so the fallback still happens on a real tap.
     */
    const acquireStill = async (kind) => {
      const isCam = kind === 'camera';
      const fileInput = root.querySelector(isCam ? '#still-input' : '#gallery-input');
      notice.hidden = true;

      if (!isNative()) {
        // web build: the file input is the only camera, and it must be opened
        // synchronously to keep the user-gesture context the picker needs
        note('使用系统选择器（网页环境）');
        fileInput.click();
        return null;
      }

      setHint(isCam ? '正在打开手机相机…' : '正在打开相册…');
      const res = isCam ? await takePhoto() : await pickPhoto();
      if (res.ok) return res.blob;

      if (res.reason === 'cancelled') {
        setHint(isCam ? '已取消拍摄。可再次点击拍摄，或从相册选择一张。' : '已取消选择。', false);
        return null;
      }
      if (res.reason === 'denied') {
        note('原生相机权限被拒绝');
        fallbackInput = isCam ? '#still-input' : '#gallery-input';
        showNotice('未获得相机权限',
          '系统未授予相机权限。请在手机「设置」中找到本应用并开启相机权限，'
          + '然后重新点击拍摄；也可以改用相册选择已有照片。', { fallback: true });
        setHint('相机权限未开启。', true);
        return null;
      }
      note(`原生${isCam ? '相机' : '相册'}失败：${res.detail || res.reason}`);
      fallbackInput = isCam ? '#still-input' : '#gallery-input';
      showNotice('未能从相机获取照片',
        '系统没有返回照片。您可以点下方按钮改用系统选择器，或从相册选择一张。',
        { fallback: true });
      setHint('未能从相机获取照片。', true);
      return null;
    };

    const shoot = async () => {
      if (busy) return;
      setBtnBusy(shootBtn, true, '正在打开相机…');
      let blob = null;
      try {
        blob = await acquireStill('camera');
      } finally {
        setBtnBusy(shootBtn, false);
      }
      if (blob) await handleBlob(blob);
    };

    const pick = async () => {
      if (busy) return;
      setBtnBusy(pickBtn, true, '正在打开相册…');
      let blob = null;
      try {
        blob = await acquireStill('photo');
      } finally {
        setBtnBusy(pickBtn, false);
      }
      if (blob) await handleBlob(blob);
    };

    shootBtn.addEventListener('click', shoot);
    pickBtn.addEventListener('click', pick);
    root.querySelector('#action-skip').addEventListener('click', () => {
      skipActionTest = true;
      actionPromptText.textContent = '已跳过动作测试';
      setHint('已跳过动作测试，本次结果会注明未做。', false);
    });
    root.querySelector('#still-input').addEventListener('change', (e) => {
      handleBlob(e.target.files?.[0]);
      e.target.value = '';
    });
    root.querySelector('#gallery-input').addEventListener('change', (e) => {
      handleBlob(e.target.files?.[0]);
      e.target.value = '';
    });
    noticeFallback.addEventListener('click', () => {
      notice.hidden = true;
      // a real tap, so the picker keeps its user-gesture context
      root.querySelector(fallbackInput).click();
    });
    noticeRetry.addEventListener('click', () => {
      notice.hidden = true;
      // drop the cached rejection, otherwise the retry can never succeed
      resetModels();
      setHint('正在重新加载面部识别模型…');
      boot();
    });

    /* --------------------------------------------------------------- live loop */

    const analyzeCurrentFrame = () => {
      const face = lastFaces[0] || null;
      const rgba = workCtx.getImageData(0, 0, ANALYSIS_W, ANALYSIS_H).data;
      const lum = luminanceStats(rgba);
      const metrics = {
        faceFound: !!face,
        faceCount: lastFaces.length,
        brightness: lum.mean,
        brightnessP5: lum.p5,
        brightnessP95: lum.p95,
        sharpness: laplacianVariance(rgba, ANALYSIS_W, ANALYSIS_H),
        yawProxy: face ? yawProxyOf(face) : Infinity,
        faceWidthRatio: face ? faceWidthRatioOf(face) : 0,
        mouthFlatness: face ? mouthFlatnessRatio(face, rgba, ANALYSIS_W, ANALYSIS_H) : null,
      };
      const res = assessFrame(metrics, CONFIG.quality);
      lastMetrics = metrics;
      setLamps(res.lamps);
      return res;
    };

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const medianOf = (values) => {
      const list = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
      if (!list.length) return null;
      const mid = Math.floor(list.length / 2);
      return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
    };

    /**
     * Sample the live camera for `durationMs` and return the measured asymmetry
     * of every frame a face was found in, already converted to percent.
     *
     * NOTE: `computeGeometry().zones` holds RAW asymmetry values in inter-ocular
     * units, not objects with a `.percent` field. The previous revision read
     * `.percent` off a number, so every action came back as 未测到 even though the
     * user really did perform them.
     */
    const sampleZones = async (durationMs) => {
      const samples = [];
      const started = performance.now();
      while (performance.now() - started < durationMs) {
        if (skipActionTest) break;
        if (video.readyState >= 2 && video.videoWidth > 0) {
          workCtx.drawImage(video, 0, 0, ANALYSIS_W, ANALYSIS_H);
          try {
            // eslint-disable-next-line no-await-in-loop
            const { faces } = await detectForVideo(video, performance.now());
            if (faces[0]) {
              const g = computeGeometry(faces[0], {
                aRef: CALIBRATION.aRef, aMax: CALIBRATION.aMax,
              });
              if (g) {
                const percents = {};
                for (const [zone, raw] of Object.entries(g.zones)) {
                  percents[zone] = zonePercent(raw, CALIBRATION.aRef, CALIBRATION.aMax);
                }
                samples.push(percents);
              }
            }
          } catch (err) {
            console.warn('[FaceStroke] action sample failed', err);
          }
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(ACTION_INTERVAL_MS);
      }
      return samples;
    };

    const percentOf = (zones, zone) => {
      const v = zones?.[zone];
      return Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
    };

    /**
     * Walk through the three actions, measuring each.
     * @returns {Promise<{skipped:boolean, reason?:string, baseline?:object, items?:Array}>}
     */
    const runActionTest = async () => {
      actionPrompt.classList.remove('hidden');
      actionPromptText.textContent = '请保持面部放松，正在记录基准';
      setHint('请保持面部放松，正在记录基准…');
      speak('请保持面部放松。');
      const baseSamples = await sampleZones(ACTION_BASELINE_MS);
      if (skipActionTest) {
        actionPrompt.classList.add('hidden');
        return { skipped: true, reason: 'user-skip' };
      }
      if (!baseSamples.length) {
        actionPrompt.classList.add('hidden');
        note('动作测试中止：基准阶段未识别到面部');
        return { skipped: true, reason: 'no-face' };
      }
      const zoneKeys = ['forehead', 'eyelid', 'mouth', 'nasolabial'];
      const baseline = {};
      for (const z of zoneKeys) {
        const m = medianOf(baseSamples.map((s) => s[z]));
        baseline[z] = m === null ? null : Math.round(m * 10) / 10;
      }

      const items = [];
      for (let i = 0; i < ACTIONS.length; i += 1) {
        const action = ACTIONS[i];
        actionPromptText.textContent = action.prompt;
        setHint(`${action.hint}（约 2 秒）`);
        speak(action.prompt);
        // audible + haptic cue: on the third action the user has their eyes shut
        cueStart();
        // eslint-disable-next-line no-await-in-loop
        await sleep(ACTION_SETTLE_MS);
        // eslint-disable-next-line no-await-in-loop
        const samples = await sampleZones(ACTION_MS);
        if (skipActionTest) {
          actionPrompt.classList.add('hidden');
          return { skipped: true, reason: 'user-skip' };
        }
        const percent = medianOf(samples.map((s) => s[action.zone]));
        const rounded = percent === null ? null : Math.round(percent * 10) / 10;
        // one lucky frame is not a measurement: report 未测到 rather than a number
        const enough = samples.length >= ACTION_MIN_SAMPLES;
        items.push({
          key: action.key,
          zone: action.zone,
          percent: enough ? rounded : null,
          before: baseline[action.zone] ?? null,
          samples: samples.length,
          notable: enough && isNotableZone(rounded),
        });
        note(`动作 ${action.key}: ${enough ? rounded : '未测到'}%（样本 ${samples.length}）`);
        // tell the user this action is over, in sound and in words
        cueActionDone();
        if (action.key === 'eyes') speak('这一项完成，请睁开眼睛。');
      }
      actionPrompt.classList.add('hidden');
      cueAllDone();
      speak('动作测试完成。');
      return { skipped: false, baseline, items };
    };

    const runBurst = async () => {
      const { framesToCapture, countdownSeconds } = CONFIG.quality;
      countdownEl.classList.remove('hidden');
      for (let i = countdownSeconds; i > 0; i -= 1) {
        countdownEl.textContent = String(i);
        // eslint-disable-next-line no-await-in-loop
        await sleep(700);
      }
      countdownEl.textContent = '拍';
      const burst = [];
      for (let i = 0; i < framesToCapture; i += 1) {
        shotCtx.drawImage(video, 0, 0, CAPTURE_W, CAPTURE_H);
        // eslint-disable-next-line no-await-in-loop
        const bitmap = await createImageBitmap(shot);
        const m = lastMetrics || {};
        burst.push({
          bitmap,
          sharpness: m.sharpness ?? 0,
          yawProxy: Number.isFinite(m.yawProxy) ? m.yawProxy : 1,
          brightness: m.brightness ?? 0,
        });
        // eslint-disable-next-line no-await-in-loop
        await sleep(100);
      }
      countdownEl.classList.add('hidden');
      setHint('采集完成，正在筛选可用帧…');

      // The three guided actions are measured now, BEFORE the camera is released.
      let actionTest = { skipped: true, reason: 'live-path-unavailable' };
      try {
        actionTest = await runActionTest();
      } catch (err) {
        console.warn('[FaceStroke] action test failed', err);
        actionTest = { skipped: true, reason: 'error' };
      }
      ctx.state.actionTest = actionTest;
      stopCamera();

      const keepIdx = pickBestFrames(burst, CONFIG.quality.framesToKeep);
      const kept = keepIdx.map((i) => burst[i]);
      burst.forEach((b, i) => { if (!keepIdx.includes(i)) b.bitmap.close?.(); });

      ctx.state.lastFrames = {
        frames: kept.map((k) => k.bitmap),
        metrics: kept.map((k) => ({ sharpness: k.sharpness, yawProxy: k.yawProxy, brightness: k.brightness })),
        capturedAt: new Date().toISOString(),
        source: 'live-camera',
      };
      ctx.navigate('#/analyze');
    };

    const loop = async () => {
      if (!running) { rafId = null; return; }
      // the burst and the action test own the video and the work canvas
      if (capturing) { rafId = requestAnimationFrame(loop); return; }
      const now = performance.now();
      if (video.readyState >= 2 && video.videoWidth > 0 && !busy) {
        markPreviewLive();
        workCtx.drawImage(video, 0, 0, ANALYSIS_W, ANALYSIS_H);
        if (!capturing && now - lastDetect > DETECT_INTERVAL_MS) {
          lastDetect = now;
          try {
            const { faces } = await detectForVideo(video, now);
            lastFaces = faces;
          } catch (err) {
            console.warn('[FaceStroke] live detection failed', err);
          }
          // VIDEO mode keeps failing: retry with the IMAGE model on the drawn
          // frame, which is slower but far more forgiving.
          if (!lastFaces.length && now - lastImageFallback > IMAGE_FALLBACK_EVERY_MS) {
            lastImageFallback = now;
            try {
              const { landmarks } = await detectLandmarksRobust(work);
              if (landmarks) lastFaces = [landmarks];
            } catch (err) {
              console.warn('[FaceStroke] image-mode fallback failed', err);
            }
          }
        }
        const res = analyzeCurrentFrame();

        if (res.passed && !capturing) {
          if (!stableSince) stableSince = now;
          setHint(primaryInstruction(res.reasons));
          if (now - stableSince > STABLE_MS) {
            capturing = true;
            runBurst();
          }
        } else {
          stableSince = 0;
          if (res.reasons.includes(REASON.NO_FACE)) {
            if (!noFaceSince) noFaceSince = now;
            const waited = now - noFaceSince;
            setHint(waited > NO_FACE_TROUBLESHOOT_MS ? TROUBLESHOOT : primaryInstruction(res.reasons), true);
            if (waited > NO_FACE_TROUBLESHOOT_MS) shootBtn.classList.add('btn-attention');
          } else {
            noFaceSince = 0;
            shootBtn.classList.remove('btn-attention');
            setHint(primaryInstruction(res.reasons), true);
          }
        }
      }
      rafId = requestAnimationFrame(loop);
    };

    /* ------------------------------------------------------------ lifecycle */

    // Returning from the system camera / picker leaves the WebView paused; the
    // video stays on its last frame unless we resume it explicitly.
    const onResume = () => {
      if (document.visibilityState && document.visibilityState !== 'visible') return;
      if (busy || photoOnly) return;
      if (!stream) { startPreview(); return; }
      if (video.paused) video.play().catch(() => {});
      if (!rafId && !capturing) { running = true; loop(); }
    };
    document.addEventListener('visibilitychange', onResume);
    window.addEventListener('focus', onResume);

    const boot = async () => {
      livePanel.hidden = !liveSupported || photoOnly;
      setHint(liveSupported ? '正在启动实时预览…' : '正在加载面部识别模型…');

      // the camera comes FIRST and the models load alongside it
      if (liveSupported && !photoOnly) {
        startPreview();
        watchPreview();
      } else if (!liveSupported) {
        showPhotoMode('当前环境未提供摄像头预览。');
        setHint('请使用手机相机拍摄一张正脸照片。', true);
      }

      const nativeOk = await prepareCamera();
      note(nativeOk ? '原生相机可用' : '原生相机不可用');

      // Preload the optional CNN channel while the user is still positioning
      // their face. It used to be loaded inside the analysis, where the whole-run
      // budget could cut it off before it ever ran.
      loadCnnModels().then((ok) => note(ok ? 'AI 通道已就绪' : 'AI 通道不可用')).catch(() => {});

      const ok = await loadModels();
      if (!ok) return;
      if (photoOnly || !liveSupported) setHint('请使用手机相机拍摄一张正脸照片。');
      else setHint('请正对镜头，保持面部位于取景框内。');
    };

    /**
     * Long-press the title five times to reveal model status. Same pattern as the
     * settings screen: developers get the internals, users never see them.
     */
    let taps = 0;
    let tapTimer = null;
    root.querySelector('#capture-title').addEventListener('click', async () => {
      taps += 1;
      if (tapTimer) clearTimeout(tapTimer);
      tapTimer = setTimeout(() => { taps = 0; }, 1200);
      if (taps < 5) return;
      taps = 0;
      const s = await warmUpStatus();
      const a = assetInfo();
      showNotice('开发者信息',
        `图像模型 ${s.image ? 'OK' : 'FAIL'} · 视频模型 ${s.video ? 'OK' : 'FAIL'}`
        + ` · 错误 ${s.error || '无'} ${s.detail || ''} · 资源方式 ${a.strategy || '未知'}`
        + ` · 原生相机 ${nativeReady() ? '可用' : '不可用'}`
        + ` · 安全上下文 ${window.isSecureContext ? '是' : '否'}`
        + ` · 预览 ${liveReady ? '运行中' : '未运行'}`
        + ` · 视频 ${video.videoWidth || 0}×${video.videoHeight || 0}`
        + ` · 记录 ${diag.join(' | ') || '无'}`, {});
    });

    teardown = () => {
      document.removeEventListener('visibilitychange', onResume);
      window.removeEventListener('focus', onResume);
      for (const t of timers) clearInterval(t);
      timers.length = 0;
      stopCamera();
    };

    speak('面部采集。请正对镜头，保持面部位于取景框内。');
    // the click that opened this screen is our chance to unlock audio playback
    primeFeedback();
    boot();
  },

  destroy() {
    if (teardown) {
      teardown();
      teardown = null;
    }
  },
};
