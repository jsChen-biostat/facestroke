/**
 * Haptic and audio feedback for the guided action test.
 *
 * WHY THIS EXISTS (device report): the third action asks the user to close their
 * eyes, and once they do, they cannot see the screen. They had no way to know
 * when the action, or the whole test, had finished. Every state change in the
 * action test therefore gets a sound and a vibration, and the end is announced
 * both audibly and in words.
 *
 * Nothing here needs an audio asset: the tones are generated with the Web Audio
 * API. The AudioContext is created lazily and resumed on the first user gesture,
 * which is what the browser autoplay policy requires.
 */

import { Capacitor } from '@capacitor/core';

let audioCtx = null;
let haptics = null;
let hapticsTried = false;

async function loadHaptics() {
  if (hapticsTried) return haptics;
  hapticsTried = true;
  if (!Capacitor?.isNativePlatform?.()) return null;
  try {
    haptics = await import('@capacitor/haptics');
  } catch (err) {
    console.warn('[FaceStroke] haptics plugin unavailable, using navigator.vibrate', err);
    haptics = null;
  }
  return haptics;
}

/**
 * Create/resume the audio context. Call this from a click handler: browsers only
 * allow audio to start inside a user gesture.
 */
export async function primeFeedback() {
  try {
    if (!audioCtx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (Ctor) audioCtx = new Ctor();
    }
    if (audioCtx?.state === 'suspended') await audioCtx.resume();
    await loadHaptics();
  } catch (err) {
    console.warn('[FaceStroke] could not prime feedback', err);
  }
}

/** A short tone. `kind` picks the pitch and length. */
function tone(kind) {
  if (!audioCtx || audioCtx.state !== 'running') return;
  const spec = {
    tick: { freq: 880, ms: 90, type: 'sine', gain: 0.12 },
    start: { freq: 660, ms: 150, type: 'sine', gain: 0.16 },
    done: { freq: 1046, ms: 260, type: 'sine', gain: 0.18 },
    finish: { freq: 1318, ms: 420, type: 'sine', gain: 0.2 },
  }[kind] || { freq: 880, ms: 100, type: 'sine', gain: 0.12 };

  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = spec.type;
    osc.frequency.value = spec.freq;
    const t = audioCtx.currentTime;
    // a short attack/decay envelope avoids an unpleasant click
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(spec.gain, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + spec.ms / 1000);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + spec.ms / 1000 + 0.02);
  } catch (err) {
    console.warn('[FaceStroke] tone failed', err);
  }
}

async function vibrate(pattern) {
  const h = await loadHaptics();
  if (h?.Haptics) {
    try {
      // the plugin exposes fixed effects, not raw patterns
      if (pattern === 'long') await h.Haptics.vibrate({ duration: 600 });
      else if (pattern === 'double') {
        await h.Haptics.vibrate({ duration: 120 });
        setTimeout(() => { h.Haptics.vibrate({ duration: 120 }).catch(() => {}); }, 180);
      } else await h.Haptics.vibrate({ duration: 90 });
      return;
    } catch (err) {
      console.warn('[FaceStroke] haptics failed, trying navigator.vibrate', err);
    }
  }
  try {
    if (typeof navigator.vibrate === 'function') {
      navigator.vibrate(pattern === 'long' ? 600 : pattern === 'double' ? [120, 120, 120] : 90);
    }
  } catch { /* vibration is a nicety, never a failure */ }
}

/** A cue that an action is about to start. */
export function cueStart() {
  tone('start');
  vibrate('short');
}

/** A cue that one action has finished. */
export function cueActionDone() {
  tone('done');
  vibrate('double');
}

/** The whole action test is over. */
export function cueAllDone() {
  tone('finish');
  vibrate('long');
}
