/* Shared helpers for the questionnaire and admin pages: language, API client, DOM, dates. */
(function () {
  'use strict';

  const cfg = window.WQ_CONFIG || {};
  const TEXT = window.WQ_TEXT;
  const FORM = window.WQ_FORM;
  const LANGS = ['cs', 'en'];
  const LANG_KEY = 'wq_lang';
  const MAX_PHOTOS = 10;

  /* ---------------- storage that never throws ---------------- */
  const store = {
    get(storage, key) {
      try {
        return window[storage].getItem(key);
      } catch (e) {
        return null;
      }
    },
    set(storage, key, value) {
      try {
        window[storage].setItem(key, value);
      } catch (e) {
        /* private mode etc. */
      }
    },
    remove(storage, key) {
      try {
        window[storage].removeItem(key);
      } catch (e) {
        /* ignore */
      }
    },
  };

  /* ---------------- language ---------------- */
  let lang = null;
  const langListeners = [];

  function browserLang() {
    const l = (navigator.language || '').toLowerCase();
    return l.startsWith('cs') || l.startsWith('sk') ? 'cs' : 'en';
  }

  /** Picks the language: ?lang= → visitor's own choice → given fallback (e.g. set by the florist) → config → browser. */
  function initLang(fallback) {
    const fromUrl = new URLSearchParams(location.search).get('lang');
    const chosen = store.get('localStorage', LANG_KEY);
    lang = [fromUrl, chosen, fallback, cfg.defaultLang, browserLang()].find((l) => LANGS.includes(l));
    applyLang();
  }

  function setLang(next) {
    if (!LANGS.includes(next) || next === lang) return;
    lang = next;
    store.set('localStorage', LANG_KEY, next);
    applyLang();
    langListeners.forEach((fn) => fn(next));
  }

  function applyLang() {
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-set-lang]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.setLang === lang)));
  }

  function t(key, vars) {
    let s = TEXT[lang] && TEXT[lang][key];
    if (s === undefined) s = TEXT.en[key];
    if (s === undefined) {
      console.warn('Missing text:', key);
      return key;
    }
    if (vars && typeof s === 'string') s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
    return s;
  }

  /* ---------------- API client (Google Apps Script web app) ---------------- */
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const apiUrl = cfg.apiUrl || (isLocal ? 'api' : '');

  class ApiError extends Error {
    constructor(code) {
      super(code);
      this.code = code;
    }
  }

  // A plain string body is sent as text/plain, which avoids a CORS preflight that Apps Script can't answer.
  async function api(action, payload) {
    if (!apiUrl) throw new ApiError('not_configured');
    let res;
    try {
      res = await fetch(apiUrl, { method: 'POST', body: JSON.stringify(Object.assign({ action }, payload)), redirect: 'follow' });
    } catch (e) {
      throw new ApiError('network');
    }
    let data;
    try {
      data = await res.json();
    } catch (e) {
      throw new ApiError('bad_response');
    }
    if (!data.ok) throw new ApiError(data.error || 'unknown');
    return data;
  }

  /** Fire-and-forget save used when the page is being closed. */
  function beacon(action, payload) {
    if (!apiUrl || !navigator.sendBeacon) return false;
    try {
      return navigator.sendBeacon(apiUrl, new Blob([JSON.stringify(Object.assign({ action }, payload))], { type: 'text/plain' }));
    } catch (e) {
      return false;
    }
  }

  /* ---------------- DOM ---------------- */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k === 'value') el.value = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      }
    }
    append(el, children);
    return el;
  }

  function append(el, children) {
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  /** Decorative line-drawn sprig. */
  function sprig(className) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 160 40');
    svg.setAttribute('class', 'sprig ' + (className || ''));
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML =
      '<g fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M8 31 C 50 31, 95 23, 138 12"/>' +
      '<path d="M32 30 C 31 22, 37 17, 45 16 C 45 23, 40 28, 32 30 Z"/>' +
      '<path d="M40 31 C 46 36, 54 37, 61 34 C 56 29, 48 28, 40 31 Z"/>' +
      '<path d="M70 26 C 70 18, 77 13, 84 13 C 83 20, 78 25, 70 26 Z"/>' +
      '<path d="M77 27 C 83 32, 91 32, 97 29 C 92 24, 84 24, 77 27 Z"/>' +
      '<path d="M104 20 C 105 13, 111 9, 117 9 C 116 15, 111 19, 104 20 Z"/>' +
      '<path d="M110 21 C 115 25, 121 25, 126 22 C 122 18, 115 18, 110 21 Z"/>' +
      '<circle cx="145" cy="10" r="2.6"/>' +
      '<path d="M145 7.4 C 142.5 2.5, 147.5 1.5, 147.6 6"/>' +
      '<path d="M147.6 10.6 C 152.5 9.5, 152.8 14.2, 148.4 13"/>' +
      '<path d="M144.6 12.6 C 144.5 17.5, 139.8 16.4, 142.2 12.4"/>' +
      '<path d="M142.4 9 C 137.8 8, 139.2 3.6, 143.2 7.4"/>' +
      '</g>';
    return svg;
  }

  /* ---------------- dates ---------------- */
  function parseDate(value) {
    if (!value) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  const locale = () => (lang === 'cs' ? 'cs-CZ' : 'en-GB');
  function fmtDate(value) {
    const d = parseDate(value);
    return d ? new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'long', year: 'numeric' }).format(d) : '';
  }
  function fmtDateTime(value) {
    const d = parseDate(value);
    return d ? new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d) : '';
  }

  /* ---------------- form helpers ---------------- */
  function isVisible(item, answers) {
    return !item.showIf || answers[item.showIf[0]] === item.showIf[1];
  }
  function hasOther(item, answers) {
    const v = answers[item.key];
    return Array.isArray(v) ? v.includes('other') : v === 'other';
  }

  /* ---------------- page chrome ---------------- */
  function initChrome() {
    const brand = document.getElementById('brand');
    if (brand) {
      brand.replaceChildren(sprig('brand-mark'));
      if (cfg.brandName) brand.append(h('span', { class: 'brand-name' }, cfg.brandName));
    }
    document.querySelectorAll('[data-set-lang]').forEach((b) => b.addEventListener('click', () => setLang(b.dataset.setLang)));
    applyLang();
  }

  window.WQ = {
    cfg,
    FORM,
    MAX_PHOTOS,
    store,
    initLang,
    setLang,
    getLang: () => lang,
    onLangChange: (fn) => langListeners.push(fn),
    t,
    api,
    beacon,
    ApiError,
    h,
    append,
    sprig,
    fmtDate,
    fmtDateTime,
    isVisible,
    hasOther,
    initChrome,
  };
})();
