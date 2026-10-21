/**
 * Consent state.
 * Spec: 09 合规与伦理文件包 第一节 / 02 §7 / 03 S1,S11
 *
 * The consent record gates EVERYTHING. If consent is absent or revoked, no
 * screen may process facial images. Keeping this in one module (rather than
 * inside the consent screen) is what makes revocation actually enforceable.
 */

const KEY = 'facestroke.consent';
export const CONSENT_VERSION = 'consent-v1.0';

export function readConsent() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch {
    return null;
  }
}

/** @returns {boolean} true only for a granted, non-revoked consent */
export function hasValidConsent() {
  const c = readConsent();
  return !!c && c.result === 'agreed' && !c.revokedAt;
}

export function grantConsent() {
  const record = {
    version: CONSENT_VERSION,
    timestamp: new Date().toISOString(),
    result: 'agreed',
  };
  localStorage.setItem(KEY, JSON.stringify(record));
  return record;
}

export function declineConsent() {
  const record = {
    version: CONSENT_VERSION,
    timestamp: new Date().toISOString(),
    result: 'declined',
  };
  localStorage.setItem(KEY, JSON.stringify(record));
  return record;
}

/**
 * Revoke consent. Processing must stop immediately; the caller is responsible
 * for offering data deletion and for navigating away from any processing screen.
 */
export function revokeConsent() {
  const prev = readConsent() || { version: CONSENT_VERSION, timestamp: null, result: 'unknown' };
  const record = { ...prev, revokedAt: new Date().toISOString() };
  localStorage.setItem(KEY, JSON.stringify(record));
  return record;
}
