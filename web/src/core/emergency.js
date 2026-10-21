/**
 * Urgent-path actions: reach a hospital, call 120, tell the family.
 * Spec: 03 功能规格 S7（紧急档三个行动入口）/ 02 §4
 *
 * Why this module exists: in the first build only 拨打 120 did anything - the
 * hospital and family buttons were alerts. The product rule is that the urgent
 * tier carries NO advice in its text, so the actions themselves have to work.
 *
 * Everything here is an OS intent (no network from the app itself) and it works
 * from a Capacitor WebView, which forwards non-http schemes to the system.
 */

import { readSettings } from './settings.js';

/**
 * Map search for nearby stroke centres.
 *
 * The Amap URI is used as the primary route because it ALWAYS produces a visible
 * result: with the app installed `callnative=1` opens the app, otherwise the web
 * page loads. A bare `geo:` intent fails silently on devices with no registered
 * handler, which is exactly the "button does nothing" complaint we are fixing.
 *
 * Replace this constant with a proper "nearest stroke centre" dataset when the
 * hospital list lands (see 03 功能规格 S7 item 6).
 */
const MAP_SEARCH_URL = 'https://uri.amap.com/search?keyword=%E5%8D%92%E4%B8%AD%E4%B8%AD%E5%BF%83&callnative=1&src=facestroke';
const MAP_FALLBACK_URL = 'https://www.amap.com/search?query=%E5%8D%92%E4%B8%AD%E4%B8%AD%E5%BF%83';

function openUrl(url) {
  try {
    const win = window.open(url, '_system');
    if (win) return true;
  } catch (err) {
    console.warn('[FaceStroke] window.open failed', err);
  }
  try {
    window.location.href = url;
    return true;
  } catch (err) {
    console.warn('[FaceStroke] location.href failed', err);
  }
  return false;
}

/** @returns {Promise<'opened'|'failed'>} */
export async function openNearbyHospitals() {
  if (openUrl(MAP_SEARCH_URL)) return 'opened';
  return openUrl(MAP_FALLBACK_URL) ? 'opened' : 'failed';
}

/** The SMS body. Deliberately does not assert a diagnosis. */
export function familyMessage(score) {
  const base = '我在用 FaceStroke 做面部健康自检，结果提示需要留意。方便时请联系我。';
  return Number.isFinite(score) ? `${base}（本次自检 ${score} 分）` : base;
}

/**
 * Send an SMS to the saved emergency contact.
 * @returns {Promise<'opened'|'no-contact'|'failed'>}
 */
export async function notifyFamily(score) {
  const s = readSettings();
  const number = (s.emergencyContact || '').trim();
  if (!number) return 'no-contact';
  const body = encodeURIComponent(familyMessage(score));
  // `sms:` opens the messaging app with the body prefilled; the user still has to
  // press send, which we consider correct for a health message.
  const ok = openUrl(`sms:${encodeURIComponent(number)}?body=${body}`);
  return ok ? 'opened' : 'failed';
}
