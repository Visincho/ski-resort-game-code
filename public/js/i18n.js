// Minimal gettext-style i18n: t('English text {x}', {x}) looks the English string up in the
// active dictionary and falls back to English.

import { IT } from './i18n-it.js';

const DICTS = { en: null, it: IT };
let lang = 'en';
try {
  lang = localStorage.getItem('snowline.lang') || (navigator.language || 'en').slice(0, 2);
} catch (e) { /* storage blocked */ }
if (!DICTS.hasOwnProperty(lang)) lang = 'en';

export function getLang() { return lang; }
export function setLang(l) {
  lang = DICTS.hasOwnProperty(l) ? l : 'en';
  try { localStorage.setItem('snowline.lang', lang); } catch (e) { /* ignore */ }
}

export function t(key, params) {
  const d = DICTS[lang];
  let s = (d && d[key]) || key;
  if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined ? params[k] : m));
  return s;
}
