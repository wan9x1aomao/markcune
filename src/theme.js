// Light / dark / follow-system.
//
// The resolved theme is written to <html data-theme="light|dark">, so every colour in style.css is
// chosen in CSS alone: no component has to know a theme exists. The setting itself lives in the
// shell's store (settings map), mirrored to localStorage so the first paint is already correct —
// window_init is async and a dark-mode user would otherwise see the light theme flash by.
import { api } from './bridge.js';

const KEY = 'theme';
const MIRROR = 'mdpad-theme';
const MEDIA = '(prefers-color-scheme: dark)';
export const THEME_VALUES = ['system', 'light', 'dark'];

let setting = 'system';
let resolved = 'light';
const listeners = new Set();

/** `system` follows the OS; `light`/`dark` are explicit. Pure, so it can be tested directly. */
export function resolveTheme(value, prefersDark) {
  if (value === 'light' || value === 'dark') return value;
  return prefersDark ? 'dark' : 'light';
}

export function themeState() {
  return { setting, resolved };
}

export function isDark() {
  return resolved === 'dark';
}

export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function paint() {
  const root = document.documentElement;
  root.dataset.theme = resolved;
  // Native scrollbars, form controls and the caret colour follow this, not our variables.
  root.style.colorScheme = resolved;
  try {
    localStorage.setItem(MIRROR, setting);
  } catch {}
  for (const fn of listeners) fn({ setting, resolved });
}

const prefersDark = () => window.matchMedia(MEDIA).matches;

/** Called before the shell answers, so the very first paint is already in the right theme. */
export function primeTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem(MIRROR);
  } catch {}
  setting = THEME_VALUES.includes(saved) ? saved : 'system';
  resolved = resolveTheme(setting, prefersDark());
  paint();
  window.matchMedia(MEDIA).addEventListener('change', () => {
    // Only follow the OS while the user has not picked a side.
    if (setting !== 'system') return;
    resolved = resolveTheme(setting, prefersDark());
    paint();
  });
}

/** Adopts what the shell stored; the store wins over the mirror (another window may have changed it). */
export function initTheme(value) {
  const next = THEME_VALUES.includes(value) ? value : 'system';
  const nextResolved = resolveTheme(next, prefersDark());
  const changed = next !== setting || nextResolved !== resolved;
  setting = next;
  resolved = nextResolved;
  if (changed) paint();
  else {
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
  }
}

/** `persist: false` is for previews (a test or a menu hover) that should not stick. */
export function setTheme(value, { persist = true } = {}) {
  const next = THEME_VALUES.includes(value) ? value : 'system';
  const nextResolved = resolveTheme(next, prefersDark());
  if (next === setting && nextResolved === resolved) return;
  setting = next;
  resolved = nextResolved;
  paint();
  if (persist) api.setSetting(KEY, setting)?.catch?.(() => {});
}

/** The button flips to the opposite of what is on screen, leaving follow-system behind. */
export function toggleTheme() {
  setTheme(resolved === 'dark' ? 'light' : 'dark');
}
