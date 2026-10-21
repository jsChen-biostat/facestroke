/**
 * Native camera access.
 *
 * Why this exists: an `<input type="file" capture="user">` does NOT open the
 * camera inside a Capacitor WebView - Android routes it to the file picker, which
 * is exactly what the first device test reported ("it opens the file manager").
 * The @capacitor/camera plugin opens the real system camera.
 *
 * On the web (dev server) the plugin is absent, so callers fall back to the file
 * input. Nothing here talks to the network.
 *
 * 2026-10-02 fourth revision. The previous version returned `null` for every
 * outcome, so the capture screen could not tell "the user pressed back" from
 * "the plugin is not there" from "permission denied" - it reported all of them
 * as "cancelled", which the user experienced as "the button does nothing".
 * Every call now returns a discriminated result and the caller can act on it.
 */

import { Capacitor } from '@capacitor/core';

let plugin = null;
let tried = false;

async function loadPlugin() {
  if (tried) return plugin;
  tried = true;
  if (!Capacitor?.isNativePlatform?.()) return null;
  try {
    plugin = await import('@capacitor/camera');
  } catch (err) {
    console.warn('[FaceStroke] @capacitor/camera unavailable, falling back to file input', err);
    plugin = null;
  }
  return plugin;
}

/**
 * Load the plugin ahead of time, during screen start-up rather than on the tap.
 *
 * This matters: the in-page file input fallback must be opened SYNCHRONOUSLY
 * inside the click handler to keep the user-gesture context, so the decision
 * "native or fallback" has to be known before the user taps.
 * @returns {Promise<boolean>} true when the native camera is usable
 */
export async function prepareCamera() {
  await loadPlugin();
  return !!plugin;
}

/** Synchronous check for the already-prepared plugin. */
export function nativeReady() {
  return !!plugin;
}

export function isNative() {
  return !!Capacitor?.isNativePlatform?.();
}

function classify(err) {
  const msg = String(err?.message || err || '');
  if (/cancel/i.test(msg)) return 'cancelled';
  if (/denied|permission|not authorized|authorization/i.test(msg)) return 'denied';
  return 'failed';
}

async function capture(sourceName, tag, labels) {
  const cam = plugin || await loadPlugin();
  if (!cam) return { ok: false, reason: 'unavailable', detail: 'plugin-missing' };
  const source = sourceName === 'photos' ? cam.CameraSource.Photos : cam.CameraSource.Camera;
  try {
    const photo = await cam.Camera.getPhoto({
      quality: 90,
      allowEditing: false,
      // DataUrl keeps everything in memory: no temp file to clean up
      resultType: cam.CameraResultType.DataUrl,
      source,
      direction: cam.CameraDirection.Front,
      ...labels,
    });
    const blob = dataUrlToBlob(photo?.dataUrl);
    if (!blob) return { ok: false, reason: 'failed', detail: 'undecodable-image' };
    return { ok: true, blob, source: tag };
  } catch (err) {
    const reason = classify(err);
    if (reason !== 'cancelled') console.warn(`[FaceStroke] ${tag} failed`, err);
    return { ok: false, reason, detail: String(err?.message || err || '') };
  }
}

/**
 * Take a photo with the system camera.
 * @returns {Promise<{ok:true,blob:Blob,source:string}|{ok:false,reason:'unavailable'|'cancelled'|'denied'|'failed',detail:string}>}
 */
export function takePhoto() {
  return capture('camera', 'native-camera', {
    promptLabelHeader: '拍摄正脸照片',
    promptLabelPhoto: '从相册选择',
    promptLabelPicture: '拍摄',
  });
}

/**
 * Pick an existing image.
 * @returns {Promise<{ok:true,blob:Blob,source:string}|{ok:false,reason:string,detail:string}>}
 */
export function pickPhoto() {
  return capture('photos', 'native-gallery', {});
}

function dataUrlToBlob(dataUrl) {
  if (!dataUrl) return null;
  try {
    const [head, body] = dataUrl.split(',');
    const mime = /:(.*?);/.exec(head)?.[1] || 'image/jpeg';
    const bin = atob(body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  } catch (err) {
    console.warn('[FaceStroke] could not decode the captured photo', err);
    return null;
  }
}
