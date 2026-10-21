/**
 * Spoken guidance via the Web Speech API.
 * Spec: 03 S1,S5,S7,S11 / 06 §2 (older users must be able to use the app
 * without reading small text)
 *
 * Everything is on-device: SpeechSynthesis does not send audio to a server in
 * any browser we target, and no text leaves the device through this module.
 */

import { getSetting } from './settings.js';

let cachedVoice = null;

export function isSupported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

function pickVoice() {
  if (cachedVoice) return cachedVoice;
  if (!isSupported()) return null;
  const voices = window.speechSynthesis.getVoices() || [];
  // prefer a Chinese voice; fall back to the browser default
  cachedVoice = voices.find((v) => /^zh/i.test(v.lang)) || null;
  return cachedVoice;
}

/**
 * Speak a short piece of UI copy.
 * @param {string} text
 * @param {{force?:boolean}} [opts]
 */
export function speak(text, opts = {}) {
  if (!text || !isSupported()) return false;
  if (!opts.force && !getSetting('voice')) return false;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    u.rate = 0.95;   // slightly slower for older listeners
    u.pitch = 1.0;
    const v = pickVoice();
    if (v) u.voice = v;
    window.speechSynthesis.speak(u);
    return true;
  } catch (err) {
    console.warn('[FaceStroke] speech failed', err);
    return false;
  }
}

/** Speak only if spoken guidance is enabled (non-critical instructions). */
export function guide(text) {
  if (!getSetting('voiceGuidance')) return false;
  return speak(text, { force: true });
}

/* --------------------------------------------------------------- throttling */

const lastSpoken = new Map();

/**
 * Speak a message at most once per `minIntervalMs`, and never twice in a row for
 * the same text. The capture screen recomputes its hint on every frame, so
 * without this the phone would talk continuously.
 *
 * @param {string} key stable identifier for the message slot
 * @param {string} text
 * @param {number} [minIntervalMs]
 */
export function guideOnce(key, text, minIntervalMs = 4000) {
  if (!text) return false;
  if (!getSetting('voiceGuidance')) return false;
  const now = Date.now();
  const prev = lastSpoken.get(key);
  if (prev && prev.text === text && now - prev.at < minIntervalMs) return false;
  if (prev && now - prev.at < minIntervalMs) return false;
  lastSpoken.set(key, { text, at: now });
  return speak(text, { force: true });
}

/** Forget throttling state (call when a screen mounts). */
export function resetGuidance() {
  lastSpoken.clear();
}

export function stopSpeaking() {
  if (!isSupported()) return;
  try {
    window.speechSynthesis.cancel();
  } catch { /* nothing to stop */ }
}

// Voices load asynchronously in most browsers; refresh the cache once ready.
if (isSupported()) {
  window.speechSynthesis.onvoiceschanged = () => { cachedVoice = null; pickVoice(); };
}
