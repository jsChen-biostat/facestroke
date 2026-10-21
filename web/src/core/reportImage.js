/**
 * Generate a shareable report image on a canvas.
 * Spec: 03 功能规格 S7 第 9 项 / S10 导出 / 06 §3.7
 *
 * RED LINE: the exported image contains NO face image and no landmarks - only the
 * score, the zone numbers and the approved copy. That is enforced by construction
 * here (this module never receives image pixels) and asserted in the unit test.
 *
 * 2026-10-02 (fifth round): saving to the phone gallery and sharing through the
 * Android share sheet (WeChat / QQ) were requested. Both need native plugins;
 * the web build keeps its download fallback.
 */

import { Capacitor } from '@capacitor/core';
import {
  TIER_LABEL, DIFFERENTIAL_REMINDER, DISCLAIMER_SHORT, ZONE_LABELS,
  ACTION_LABELS, ACTION_TEST_NOTE, actionSkipText, RESULT_LIMITATION,
} from './report.js';
import { ADVICE } from './knowledge.js';

const W = 720;
// tall enough for the score, the zone table, the action test, the limitation,
// the advice list and the disclaimer - the disclaimer must never be pushed off
const H = 1780;
const PAD = 44;

const COLORS = {
  bg: '#ffffff',
  text: '#14202e',
  muted: '#4a5a6a',
  line: '#d3dce6',
  A: '#1a7f4b',
  B: '#b8860b',
  C: '#c25203',
  D: '#b3261e',
};

function wrap(ctx, text, maxWidth) {
  const lines = [];
  let line = '';
  for (const ch of text) {
    const test = line + ch;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = ch;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function paragraph(ctx, text, x, y, maxWidth, lineHeight, color, font) {
  ctx.font = font;
  ctx.fillStyle = color;
  let cursor = y;
  for (const line of wrap(ctx, text, maxWidth)) {
    ctx.fillText(line, x, cursor);
    cursor += lineHeight;
  }
  return cursor;
}

/**
 * @param {object} result the ctx.state.lastResult object
 * @param {object} opts { appVersion, copyVersion, thresholdsApproved }
 * @returns {HTMLCanvasElement}
 */
export function renderReportCanvas(result, opts = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, H);

  // header
  ctx.fillStyle = '#0b6bcb';
  ctx.fillRect(0, 0, W, 8);

  ctx.fillStyle = COLORS.text;
  ctx.font = 'bold 40px system-ui, "Microsoft YaHei", sans-serif';
  ctx.fillText('FaceStroke · 面部健康自检', PAD, 96);

  ctx.font = '24px system-ui, "Microsoft YaHei", sans-serif';
  ctx.fillStyle = COLORS.muted;
  ctx.fillText(`检测时间：${String(result.timestamp || '').slice(0, 19).replace('T', ' ')}`, PAD, 140);

  // score
  ctx.fillStyle = COLORS.text;
  ctx.font = 'bold 132px system-ui, sans-serif';
  ctx.fillText(String(result.score), PAD, 300);
  const scoreWidth = ctx.measureText(String(result.score)).width;
  ctx.font = '26px system-ui, "Microsoft YaHei", sans-serif';
  ctx.fillStyle = COLORS.muted;
  ctx.fillText('分（100 = 两侧对称）', PAD + scoreWidth + 16, 296);

  // tier
  const tier = result.tier;
  const tierColor = COLORS[tier] || COLORS.muted;
  ctx.strokeStyle = tierColor;
  ctx.lineWidth = 3;
  const label = tier ? TIER_LABEL[tier] : '本次未分档';
  ctx.font = 'bold 32px system-ui, "Microsoft YaHei", sans-serif';
  const labelWidth = ctx.measureText(label).width;
  ctx.strokeRect(PAD, 336, labelWidth + 40, 58);
  ctx.fillStyle = tierColor;
  ctx.fillText(label, PAD + 20, 376);

  let y = 440;

  // conclusion
  const conclusion = result.report?.blocks?.find((b) => b.kind === 'conclusion')?.text || '';
  y = paragraph(ctx, conclusion, PAD, y, W - PAD * 2, 40, COLORS.text,
    '30px system-ui, "Microsoft YaHei", sans-serif');
  y += 20;

  // zone table
  ctx.strokeStyle = COLORS.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD, y);
  ctx.lineTo(W - PAD, y);
  ctx.stroke();
  y += 44;

  ctx.font = 'bold 28px system-ui, "Microsoft YaHei", sans-serif';
  ctx.fillStyle = COLORS.text;
  ctx.fillText('分区不对称度（几何测量）', PAD, y);
  y += 44;

  const order = ['mouth', 'eyelid', 'nasolabial', 'forehead'];
  ctx.font = '28px system-ui, "Microsoft YaHei", sans-serif';
  for (const z of order) {
    const info = result.zones?.[z];
    if (!info) continue;
    ctx.fillStyle = COLORS.text;
    ctx.fillText(ZONE_LABELS[z] || z, PAD, y);
    const pct = info.percent === null || info.percent === undefined ? '—' : `${info.percent}%`;
    ctx.fillStyle = COLORS.muted;
    const w = ctx.measureText(pct).width;
    ctx.fillText(pct, W - PAD - w, y);
    y += 40;
    ctx.strokeStyle = '#eef2f6';
    ctx.beginPath();
    ctx.moveTo(PAD, y - 26);
    ctx.lineTo(W - PAD, y - 26);
    ctx.stroke();
  }

  // action test: the measured values, or an explicit "not done"
  y += 8;
  ctx.font = 'bold 26px system-ui, "Microsoft YaHei", sans-serif';
  ctx.fillStyle = COLORS.text;
  ctx.fillText('动作测试', PAD, y);
  y += 36;
  const at = result.actionTest;
  if (at && !at.skipped && at.items?.length) {
    for (const it of at.items) {
      ctx.font = '24px system-ui, "Microsoft YaHei", sans-serif';
      ctx.fillStyle = COLORS.text;
      ctx.fillText(ACTION_LABELS[it.key] || it.key, PAD, y);
      const val = Number.isFinite(it.percent) ? `${it.percent}%` : '未测到';
      ctx.fillStyle = COLORS.muted;
      const vw = ctx.measureText(val).width;
      ctx.fillText(val, W - PAD - vw, y);
      y += 34;
    }
    y = paragraph(ctx, ACTION_TEST_NOTE, PAD, y, W - PAD * 2, 30, COLORS.muted,
      '21px system-ui, "Microsoft YaHei", sans-serif');
  } else {
    y = paragraph(ctx, actionSkipText(at?.reason), PAD, y, W - PAD * 2, 30, COLORS.muted,
      '21px system-ui, "Microsoft YaHei", sans-serif');
  }
  y += 18;

  // AI channel note
  const cnnNote = result.fusion?.cnnUsed
    ? (result.fusion.cnnRole === 'cross-check'
      ? `AI 通道：交叉校验 ${result.cnnScore} 分（与几何相差 ${Number(result.fusion.gap).toFixed(1)} 分），不参与最终分数。`
      : `AI 通道：已参与打分 ${result.cnnScore} 分。`)
    : 'AI 通道：本次未参与。';
  y = paragraph(ctx, cnnNote, PAD, y, W - PAD * 2, 30, COLORS.muted,
    '21px system-ui, "Microsoft YaHei", sans-serif');
  y += 18;

  // differential reminder
  y = paragraph(ctx, DIFFERENTIAL_REMINDER, PAD, y, W - PAD * 2, 30, COLORS.muted,
    '21px system-ui, "Microsoft YaHei", sans-serif');
  y += 18;

  // what the measurement can and cannot say - must travel with the report
  y = paragraph(ctx, RESULT_LIMITATION, PAD, y, W - PAD * 2, 30, COLORS.text,
    '21px system-ui, "Microsoft YaHei", sans-serif');
  y += 18;

  // everyday advice: the reader of a shared report is usually family. Only the
  // rotated slice travels in the image, so the report stays readable.
  ctx.font = 'bold 26px system-ui, "Microsoft YaHei", sans-serif';
  ctx.fillStyle = COLORS.text;
  ctx.fillText('日常建议', PAD, y);
  y += 34;
  const advice = Array.isArray(result.adviceBatch) && result.adviceBatch.length
    ? result.adviceBatch
    : ADVICE.slice(0, 4);
  for (const item of advice) {
    y = paragraph(ctx, `· ${item.title}：${item.body}`, PAD, y, W - PAD * 2, 30, COLORS.muted,
      '21px system-ui, "Microsoft YaHei", sans-serif');
    y += 4;
  }
  y += 14;

  // disclaimer box - a shared report is read by family members, so the
  // "not a medical device" statement must travel with it
  ctx.fillStyle = '#f6f8fb';
  const boxTop = y - 24;
  ctx.fillRect(PAD, boxTop, W - PAD * 2, 178);
  let dy = paragraph(ctx, '本工具不是医疗器械，不提供诊断，结果仅供参考，不能替代医生判断。',
    PAD + 16, y + 12, W - PAD * 2 - 32, 34, COLORS.text,
    'bold 24px system-ui, "Microsoft YaHei", sans-serif');
  dy = paragraph(ctx, DISCLAIMER_SHORT, PAD + 16, dy, W - PAD * 2 - 32, 34, COLORS.muted,
    '24px system-ui, "Microsoft YaHei", sans-serif');
  paragraph(ctx, '本报告不含照片，也不含任何面部图像数据。', PAD + 16, dy, W - PAD * 2 - 32, 34,
    COLORS.muted, '22px system-ui, "Microsoft YaHei", sans-serif');

  // footer
  ctx.font = '20px system-ui, sans-serif';
  ctx.fillStyle = COLORS.muted;
  const fp = result.modelVersions || {};
  ctx.fillText(`几何 ${fp.geo || '—'} · AI ${fp.cnn || '—'} · 融合 ${fp.fusion || '—'}`, PAD, H - 58);
  ctx.fillText(`FaceStroke ${opts.appVersion || ''}`.trim(), PAD, H - 28);

  return canvas;
}

/** @returns {Promise<Blob|null>} */
export function reportBlob(result, opts) {
  const canvas = renderReportCanvas(result, opts);
  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), 'image/png', 0.95);
  });
}

/**
 * Share the report image through the OS share sheet, which is what reaches
 * WeChat / QQ / mail. Falls back to a download on the web.
 * @returns {Promise<'shared'|'downloaded'|'cancelled'|'failed'>}
 */
export async function shareReportImage(result, opts = {}) {
  const blob = await reportBlob(result, opts);
  if (!blob) return 'failed';
  const name = `${reportFileName(result)}.png`;

  if (!Capacitor.isNativePlatform()) return shareOnWeb(blob, name);

  try {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const { Share } = await import('@capacitor/share');
    const written = await Filesystem.writeFile({
      path: name,
      data: await blobToBase64(blob),
      directory: Directory.Cache,
      recursive: true,
    });
    await Share.share({
      title: '面部健康自检报告',
      text: '这是我的一次面部自检结果，仅供参考，不是诊断。',
      files: [written.uri],
      dialogTitle: '分享检测报告',
    });
    return 'shared';
  } catch (err) {
    const msg = String(err?.message || err || '');
    if (/cancel/i.test(msg)) return 'cancelled';
    console.warn('[FaceStroke] native share failed, falling back to a download', err);
    return (await downloadBlob(blob, name)) ? 'downloaded' : 'failed';
  }
}

function reportFileName(result) {
  const stamp = String(result.timestamp || '').slice(0, 19).replace(/[:T]/g, '-');
  return `FaceStroke-${stamp || 'report'}`;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error('read-failed'));
    reader.readAsDataURL(blob);
  });
}

function blobToBase64(blob) {
  return blobToDataUrl(blob).then((url) => String(url).split(',')[1] || '');
}

/**
 * Find (or create) our album and return its identifier.
 * The Android implementation requires an album identifier to save into.
 */
async function ensureAlbum(Media) {
  const NAME = 'FaceStroke';
  const list = async () => (await Media.getAlbums()).albums || [];
  let albums = await list();
  let found = albums.find((a) => a.name === NAME);
  if (!found) {
    try {
      await Media.createAlbum({ name: NAME });
    } catch (err) {
      console.warn('[FaceStroke] could not create the album, trying an existing one', err);
    }
    albums = await list();
    found = albums.find((a) => a.name === NAME);
  }
  if (!found) [found] = albums;
  return found?.identifier;
}

/**
 * Save the report image to the phone's gallery.
 * @returns {Promise<'saved'|'unsupported'|'denied'|'failed'>}
 */
export async function saveReportToGallery(result, opts = {}) {
  const blob = await reportBlob(result, opts);
  if (!blob) return 'failed';

  if (!Capacitor.isNativePlatform()) {
    // web build: a download is the closest equivalent
    const ok = await downloadBlob(blob, `${reportFileName(result)}.png`);
    return ok ? 'unsupported' : 'failed';
  }
  try {
    const Media = await import('@capacitor-community/media');
    const dataUrl = await blobToDataUrl(blob);
    const albumIdentifier = await ensureAlbum(Media.Media);
    const payload = { path: dataUrl, fileName: reportFileName(result) };
    if (albumIdentifier) payload.albumIdentifier = albumIdentifier;
    await Media.Media.savePhoto(payload);
    return 'saved';
  } catch (err) {
    const msg = String(err?.message || err || '');
    console.warn('[FaceStroke] savePhoto failed', err);
    return /permission|denied|authoriz/i.test(msg) ? 'denied' : 'failed';
  }
}

async function downloadBlob(blob, name) {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return true;
  } catch (err) {
    console.error('[FaceStroke] download failed', err);
    return false;
  }
}

/** Web Share API where it exists (desktop Chrome, iOS Safari), download otherwise. */
async function shareOnWeb(blob, name) {
  const file = new File([blob], name, { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: '面部健康自检报告', text: '这是我的一次面部自检结果。' });
      return 'shared';
    } catch (err) {
      if (err && err.name === 'AbortError') return 'cancelled';
      console.warn('[FaceStroke] web share failed, falling back to download', err);
    }
  }
  return (await downloadBlob(blob, name)) ? 'downloaded' : 'failed';
}

/** Kept so the records screen keeps working; same behaviour as shareReportImage. */
export const shareReport = shareReportImage;
