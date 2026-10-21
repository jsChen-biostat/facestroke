/**
 * FaceStroke app entry + hash router.
 * Screen ids and order follow 03_功能规格与分批路线.md (S1..S12).
 * No framework on purpose: fewer moving parts for an AI to keep consistent.
 *
 * 2026-10-02 changes (user feedback round 1):
 *  - a persistent 返回 button, backed by an in-app navigation stack, so the user
 *    never has to force-quit to go back
 *  - the developer banner is GONE from the product; config problems are reported
 *    to the console only
 *  - the footer disclaimer button now opens a real page
 */

import { CONFIG, missingConfig } from './core/config.js';
import { applyStoredFontSize } from './core/settings.js';

import s1Consent from './screens/s1_consent.js';
import s2Home from './screens/s2_home.js';
import s3Gate from './screens/s3_gate.js';
import s4Prep from './screens/s4_prep.js';
import s5Capture from './screens/s5_capture.js';
import s6Analyze from './screens/s6_analyze.js';
import s7Result from './screens/s7_result.js';
import s8Algorithm from './screens/s8_algorithm.js';
import s9Privacy from './screens/s9_privacy.js';
import s10Records from './screens/s10_records.js';
import s11Settings from './screens/s11_settings.js';
import s12Disclaimer from './screens/s12_disclaimer.js';

export const SCREENS = [
  s1Consent, s2Home, s3Gate, s4Prep, s5Capture, s6Analyze,
  s7Result, s8Algorithm, s9Privacy, s10Records, s11Settings, s12Disclaimer,
];

const byRoute = new Map(SCREENS.map((s) => [s.route, s]));
const DEFAULT_ROUTE = '#/home';

/** Screens that must not offer a back button (entry points / dead ends). */
const NO_BACK = new Set(['#/home', '#/consent']);

/** Shared, in-memory session state (never persisted unless a screen says so). */
export const state = {
  consent: null,        // { version, timestamp }
  gate: null,           // { ageBand, risks, symptoms }
  mode: null,           // 'EMERGENCY' | 'UNLOCK_RISK_LAYER' | 'BASIC_ONLY'
  lastFrames: null,     // ImageBitmap[] held in memory only, released after use
  lastResult: null,     // { score, geo, cnn, tier, modelVersions, timestamp }
};

/** In-app navigation stack, so 返回 works even where history is unreliable. */
const navStack = [];

function currentRoute() {
  return location.hash || DEFAULT_ROUTE;
}

export const ctx = {
  /** Navigate forward. */
  navigate(route) {
    const here = currentRoute();
    if (route === here) {
      router();
      return;
    }
    navStack.push(here);
    if (navStack.length > 30) navStack.shift();
    location.hash = route;
  },

  /** Go back one step; falls back to the home screen. */
  back() {
    const prev = navStack.pop();
    if (prev && byRoute.has(prev)) {
      location.hash = prev;
    } else {
      location.hash = DEFAULT_ROUTE;
    }
  },

  /** Drop the stack (used when a flow starts over). */
  resetStack() {
    navStack.length = 0;
  },

  state,
  config: CONFIG,
  missingConfig,
};

let currentScreen = null;

function renderChrome(route) {
  const bar = document.getElementById('appbar');
  const showBack = !NO_BACK.has(route) && navStack.length > 0;
  bar.hidden = !showBack;
}

function router() {
  const root = document.getElementById('app');
  const route = currentRoute();
  const screen = byRoute.get(route);

  if (currentScreen && typeof currentScreen.destroy === 'function') {
    try {
      currentScreen.destroy();
    } catch (err) {
      console.error('[FaceStroke] screen.destroy failed', err);
    }
  }
  currentScreen = screen || null;

  if (!screen) {
    root.innerHTML = `
      <h1 class="screen-title">页面不存在</h1>
      <button class="btn-primary" data-nav="${DEFAULT_ROUTE}">返回首页</button>`;
  } else {
    root.innerHTML = '';
    screen.render(root, ctx);
  }

  renderChrome(route);
  window.scrollTo(0, 0);
}

/**
 * Navigation is handled by ONE delegated listener.
 *
 * 2026-10-02 (device test 5): buttons were wired with
 * `root.querySelectorAll('[data-nav]')` immediately after render(). Any button a
 * screen inserted LATER - the analysis screen's "重新采集" button, which only
 * appears when the capture quality is rejected - was therefore never wired, and
 * tapping it did nothing. Delegation covers buttons that do not exist yet.
 */
function wireNavigation() {
  document.getElementById('app')?.addEventListener('click', (event) => {
    const back = event.target.closest('[data-back]');
    if (back) {
      ctx.back();
      return;
    }
    const nav = event.target.closest('[data-nav]');
    if (nav) ctx.navigate(nav.getAttribute('data-nav'));
  });
}

/**
 * Startup self-check.
 * 2026-10-02: this used to paint a yellow banner into the product UI. Users are
 * not developers and must never see internal state, so it now only logs.
 */
function startupCheck() {
  const missing = missingConfig();
  if (missing.length) {
    console.warn('[FaceStroke] unresolved config values:', missing.join(', '));
  }
}

window.addEventListener('hashchange', router);

document.addEventListener('DOMContentLoaded', () => {
  wireNavigation();
  document.getElementById('appbar-back')?.addEventListener('click', () => ctx.back());
  document.getElementById('footer-disclaimer')?.addEventListener('click', () => {
    ctx.navigate('#/disclaimer');
  });
});

applyStoredFontSize();
startupCheck();
router();

// Expose for manual debugging from the phone console.
window.__facestroke = { CONFIG, state, missingConfig };
