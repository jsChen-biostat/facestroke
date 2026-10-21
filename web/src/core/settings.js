/**
 * User settings, persisted locally.
 * Spec: 03 功能规格 S11 / 06 §3.10
 *
 * Font size is an accessibility requirement (the target users are older
 * adults); the palsy marker is a safety requirement (without it a person with
 * known facial palsy would be shown the urgent tier on every single test).
 */

const KEY = 'facestroke.settings';

export const DEFAULTS = {
  fontSize: 'normal',    // normal | large | xlarge
  voice: true,           // read the result aloud
  voiceGuidance: true,   // spoken guidance on other screens
  palsy: false,          // "I have facial palsy / my face changed recently"
  reminder: 'off',       // off | weekly | biweekly | monthly
  emergencyName: '',     // used by the 通知家人 action
  emergencyContact: '',  // phone number for the SMS
};

export function readSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  localStorage.setItem(KEY, JSON.stringify(next));
  if (patch.fontSize) applyFontSize(next.fontSize);
  return next;
}

export function getSetting(key) {
  return readSettings()[key];
}

export function setSetting(key, value) {
  return writeSettings({ [key]: value });
}

/** Font scale is applied on <html data-fontsize> so all rem sizes follow. */
export function applyFontSize(v) {
  if (!v || v === 'normal') document.documentElement.removeAttribute('data-fontsize');
  else document.documentElement.setAttribute('data-fontsize', v);
}

export function applyStoredFontSize() {
  applyFontSize(readSettings().fontSize);
}
