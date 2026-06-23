// ==UserScript==
// @name         Immersive Translate (OpenAI)
// @namespace    https://github.com/plateaukao/immersive-script
// @homepageURL  https://github.com/plateaukao/immersive-script
// @supportURL   https://github.com/plateaukao/immersive-script/issues
// @updateURL    https://github.com/plateaukao/immersive-script/raw/refs/heads/main/immersive-translate-openai.user.js
// @downloadURL  https://github.com/plateaukao/immersive-script/raw/refs/heads/main/immersive-translate-openai.user.js
// @version      0.6.0
// @description  Bilingual immersive web page translation via Google Translate, Microsoft Translator (both free, no key), the OpenAI API, or any OpenAI-compatible server
// @author       Daniel Kao
// @match        *://*/*
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @connect      *
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  // ===================================================================
  // 1. CONSTANTS & DEFAULTS
  // ===================================================================

  const SETTINGS_KEY = 'imtx:settings';
  const LOG_PREFIX = '[imtx]';

  const MAX_BATCH_CHARS = 4000;   // max source chars packed into one request
  const CACHE_MAX_ENTRIES = 2000;
  const RATE_LIMIT = 5;           // max request starts per RATE_INTERVAL
  const RATE_INTERVAL = 1300;     // ms
  const RETRY_BACKOFF = [1000, 3000]; // ms; length = retry count
  const REQUEST_TIMEOUT = 60000;  // ms
  const FREE_CONCURRENCY = 5;     // in-flight cap for Google/Microsoft (they fan out per paragraph)
  const FLUSH_DEBOUNCE = 150;     // ms, viewport queue
  const MUTATION_DEBOUNCE = 300;  // ms, dynamic content re-scan

  const DEFAULTS = {
    schemaVersion: 1,
    engine: 'google',             // 'openai' | 'google' | 'bing'; default to free & keyless Google
    apiBaseUrl: 'https://api.openai.com/v1', // full base incl. /v1; /chat/completions is appended
    apiKeys: '',                  // comma-separated; random rotation per request
    model: 'gpt-4o-mini',
    targetLang: 'zh-TW',
    temperature: 0,
    systemPrompt: '',             // empty = built-in default; supports {{to}}
    userPromptTemplate: '',       // empty = built-in; single-paragraph requests only; {{to}}, {{text}}
    batchSize: 10,                // max segments per chat request (1 disables batching)
    maxConcurrent: 2,             // in-flight cap for OpenAI; free engines use FREE_CONCURRENCY (5)
    minTextLength: 18,
    displayStyle: 'none',         // see DISPLAY_STYLES
    buttonPos: null,              // {right, bottom} in px, set by dragging the floating button
    idleDimSeconds: 5,            // dim the floating button after this many idle seconds; 0 = never
    idleDimOpacity: 0.3,          // opacity when dimmed (0.3 ≈ 70% transparent)
    hotkey: 'Alt+T',
    autoDomains: [],              // hostnames, suffix-matched ("example.com" covers "www.example.com")
    hiddenButtonDomains: [],      // hostnames where the floating button is hidden (suffix-matched)
    debug: false,
  };

  const DEFAULT_SYSTEM_PROMPT =
    'You are a translation engine. You translate text and never explain, answer questions, or add commentary. Preserve all %%N%% marker lines exactly as given.';
  const DEFAULT_SINGLE_PROMPT =
    'Translate the text below to {{to}}:\n\n{{text}}';
  const BATCH_PROMPT_HEADER =
    'Translate each numbered segment below into {{to}}. Reply with the same %%N%% marker line before each translated segment, in the same order, and nothing else.';

  const DISPLAY_STYLES = ['none', 'faded', 'italic', 'dashed', 'dotted', 'wavy', 'quote'];

  const LANG_NAMES = {
    'zh-TW': 'Traditional Chinese (zh-TW)',
    'zh-CN': 'Simplified Chinese (zh-CN)',
    'zh': 'Chinese',
    'en': 'English',
    'ja': 'Japanese',
    'ko': 'Korean',
    'fr': 'French',
    'de': 'German',
    'es': 'Spanish',
  };

  // Engine picker shown in settings. OpenAI needs a key; Google/Microsoft are free.
  const ENGINE_OPTIONS = [
    { value: 'openai', label: 'OpenAI / compatible (needs API key)' },
    { value: 'google', label: 'Google Translate (free, no key)' },
    { value: 'bing', label: 'Microsoft Translator (free, no key)' },
  ];

  // Free engines want non-BCP-47 codes for Chinese (Bing by script, Google by
  // region); everything else (en, ja, fr, …) passes through unchanged.
  const GOOGLE_LANG = { 'zh': 'zh-CN', 'zh-cn': 'zh-CN', 'zh-tw': 'zh-TW', 'zh-hans': 'zh-CN', 'zh-hant': 'zh-TW' };
  const BING_LANG = { 'zh': 'zh-Hans', 'zh-cn': 'zh-Hans', 'zh-tw': 'zh-Hant', 'zh-hans': 'zh-Hans', 'zh-hant': 'zh-Hant' };
  function mapLang(map, code) {
    const l = String(code || '').toLowerCase();
    return map[l] || code;
  }

  // Block-level tags: presence as a child disqualifies a parent from being a leaf unit.
  const BLOCK_TAGS = new Set([
    'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'DD', 'DT', 'BLOCKQUOTE',
    'FIGCAPTION', 'CAPTION', 'TD', 'TH', 'DIV', 'SECTION', 'ARTICLE', 'MAIN',
    'ASIDE', 'HEADER', 'FOOTER', 'UL', 'OL', 'DL', 'TABLE', 'THEAD', 'TBODY',
    'TFOOT', 'TR', 'FIGURE', 'FORM', 'FIELDSET', 'DETAILS', 'SUMMARY', 'PRE',
    'NAV', 'ADDRESS', 'HR',
  ]);

  // Tags eligible to be a translation unit (leaf blocks of these kinds get translated).
  const UNIT_TAGS = new Set([
    'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'DD', 'DT', 'BLOCKQUOTE',
    'FIGCAPTION', 'CAPTION', 'TD', 'TH', 'DIV', 'SECTION', 'ARTICLE',
    'ASIDE', 'SUMMARY', 'ADDRESS',
  ]);

  // Subtrees never descended into.
  const EXCLUDE_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'INPUT', 'SELECT',
    'BUTTON', 'CODE', 'PRE', 'KBD', 'SAMP', 'SVG', 'MATH', 'CANVAS', 'IFRAME',
    'VIDEO', 'AUDIO', 'NAV',
  ]);
  const EXCLUDE_CLOSEST =
    'script,style,noscript,template,textarea,input,select,button,code,pre,kbd,samp,svg,math,canvas,iframe,video,audio,nav,' +
    '[aria-hidden="true"],[contenteditable=""],[contenteditable="true"],.imtx-root,.imtx-translation,.imtx-seg';

  // Block containers whose loose, <br>-separated text is split into one unit per
  // paragraph (bilingual interleave) instead of translating the whole body as a
  // single blob. Limited to tags where injecting a <span> wrapper is always valid.
  const SEGMENT_TAGS = new Set(['DIV', 'ARTICLE', 'SECTION', 'ASIDE', 'TD', 'BLOCKQUOTE']);

  // Translation priority from the nearest landmark ancestor (lower = sooner), so
  // the article body translates before page chrome (header/footer/aside) when
  // several units enter the queue in the same tick.
  const PRIORITY_TAGS = { ARTICLE: 0, MAIN: 0, SECTION: 2, ASIDE: 4, HEADER: 4, FOOTER: 4 };
  const PRIORITY_DEFAULT = 3;

  function log(...args) {
    if (Store.get().debug) console.log(LOG_PREFIX, ...args);
  }
  function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
  function langName(code) {
    return LANG_NAMES[code] || code;
  }

  // Primary language subtag, lowercased: "en-US" -> "en", "zh_TW" -> "zh".
  function primarySubtag(code) {
    return String(code || '').toLowerCase().split(/[-_]/)[0];
  }

  // The page's own declared language, from <html lang> or a content-language meta.
  function pageLang() {
    const htmlLang = (document.documentElement.getAttribute('lang') || '').trim();
    if (htmlLang) return htmlLang;
    const meta = document.querySelector('meta[http-equiv="content-language" i]');
    const metaLang = meta && meta.getAttribute('content');
    return (metaLang || '').split(',')[0].trim();
  }

  // True when the page is already in the target language (same primary subtag) —
  // nothing to translate, so the floating button can stay hidden by default.
  function pageLangIsTarget() {
    const pl = primarySubtag(pageLang());
    return !!pl && pl === primarySubtag(S().targetLang);
  }

  // ===================================================================
  // 2. STORE (settings)
  // ===================================================================

  const Store = (() => {
    let settings = null;
    const listeners = [];

    function load() {
      let raw = {};
      try {
        raw = JSON.parse(GM_getValue(SETTINGS_KEY, '{}'));
      } catch (e) {
        warn('settings parse failed, using defaults', e);
      }
      settings = Object.assign({}, DEFAULTS, raw);
      return settings;
    }

    return {
      get() {
        return settings || load();
      },
      save(patch) {
        settings = Object.assign({}, this.get(), patch);
        GM_setValue(SETTINGS_KEY, JSON.stringify(settings));
        listeners.forEach((fn) => fn(settings));
      },
      onChange(fn) {
        listeners.push(fn);
      },
    };
  })();

  const S = () => Store.get();

  // ===================================================================
  // 3. CACHE (in-memory, FIFO-capped)
  // ===================================================================

  const Cache = (() => {
    const map = new Map();
    return {
      key(text) {
        return `${S().engine}|${S().targetLang}|${S().model}|${text}`;
      },
      get(text) {
        return map.get(this.key(text));
      },
      set(text, translation) {
        if (map.size >= CACHE_MAX_ENTRIES) {
          map.delete(map.keys().next().value); // FIFO eviction
        }
        map.set(this.key(text), translation);
      },
    };
  })();

  // ===================================================================
  // 4. LANG DETECT (Han-ratio heuristic; only applied for zh targets)
  // ===================================================================

  function isAlreadyTarget(text) {
    if (!S().targetLang.toLowerCase().startsWith('zh')) return false;
    let han = 0, kana = 0, visible = 0;
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp <= 0x20) continue;
      visible++;
      if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf)) han++;
      else if (cp >= 0x3040 && cp <= 0x30ff) kana++; // kana => Japanese, still translate
    }
    if (!visible) return true;
    return han / visible > 0.5 && kana / visible < 0.05;
  }

  // ===================================================================
  // 5. TRANSLATION ENGINES (OpenAI chat + Google/Microsoft free web APIs)
  // ===================================================================

  class ApiError extends Error {
    constructor(kind, status, message, retryAfter) {
      super(message);
      this.kind = kind;     // auth | rate | server | network | parse
      this.status = status;
      this.retryAfter = retryAfter; // seconds, from a Retry-After header if present
    }
  }

  // Rate-limited GM_xmlhttpRequest, resolving with the raw response. Every engine
  // (chat, Google/Bing segment, Bing token fetch) shares the one limiter, so an
  // engine that fans out a request per paragraph is throttled like a batch.
  async function request(opts) {
    await RateLimiter.acquire();
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: opts.method, url: opts.url, headers: opts.headers, data: opts.data,
        timeout: REQUEST_TIMEOUT,
        onload: resolve,
        onerror: () => reject(new ApiError('network', 0, 'network error (check connectivity / @connect)')),
        ontimeout: () => reject(new ApiError('network', 0, 'request timed out')),
      });
    });
  }

  // Map an HTTP error response to an ApiError. authFatal (OpenAI only) makes
  // 401/403 a fatal 'auth' that pauses the queue; free engines retry instead,
  // since a 4xx there is a temporary block rather than a bad key.
  function httpError(res, msg, authFatal) {
    const s = res.status;
    if (authFatal && (s === 401 || s === 403)) return new ApiError('auth', s, msg);
    if (s === 429) {
      const m = /retry-after:\s*(\d+)/i.exec(res.responseHeaders || '');
      return new ApiError('rate', s, msg, m ? parseInt(m[1], 10) : undefined);
    }
    return new ApiError('server', s, msg);
  }

  function pickKey() {
    const keys = S().apiKeys.split(',').map((k) => k.trim()).filter(Boolean);
    return keys.length ? keys[Math.floor(Math.random() * keys.length)] : '';
  }

  // One OpenAI-compatible chat completion. Returns the assistant message text.
  async function chat(messages) {
    const url = S().apiBaseUrl.replace(/\/+$/, '') + '/chat/completions';
    const key = pickKey();
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers.Authorization = 'Bearer ' + key;
    const data = JSON.stringify({ model: S().model, temperature: S().temperature, stream: false, messages });
    log('request', url, messages);
    const res = await request({ method: 'POST', url, headers, data });
    let json = null;
    try { json = JSON.parse(res.responseText); } catch (e) { /* handled below */ }
    if (res.status === 200) {
      const content = json && json.choices && json.choices[0] &&
        json.choices[0].message && json.choices[0].message.content;
      if (typeof content === 'string') return content;
      throw new ApiError('parse', 200, 'unexpected response: ' + String(res.responseText).slice(0, 300));
    }
    const msg = (json && json.error && json.error.message) ||
      String(res.responseText).slice(0, 300) || ('HTTP ' + res.status);
    throw httpError(res, msg, true);
  }

  // Each engine: translate(texts) -> Promise<string[]> aligned to texts, throwing
  // ApiError on failure. packSize() caps segments per call; needsKey gates enable().
  // Free engines share this plumbing: one keyless request per paragraph.
  const FREE_ENGINE = {
    needsKey: false,
    packSize: () => 1,
    concurrency: () => FREE_CONCURRENCY,
    translate(texts) { return Promise.all(texts.map((t) => this.one(t))); },
  };

  const Engines = {
    // OpenAI / compatible: marker-batched chat, falling back to one request per
    // paragraph when the model mangles the %%N%% markers.
    openai: {
      needsKey: true,
      packSize: () => S().batchSize,
      concurrency: () => S().maxConcurrent,
      async translate(texts) {
        if (texts.length === 1) return [(await chat(Batcher.singleMessages(texts[0]))).trim()];
        const content = await chat(Batcher.batchMessages(texts));
        const parsed = Batcher.parse(content, texts.length);
        if (parsed) return texts.map((_, i) => parsed.get(i + 1));
        warn('batch marker mismatch, falling back to per-paragraph. Raw reply:', content);
        return Promise.all(texts.map((t) => chat(Batcher.singleMessages(t)).then((c) => c.trim())));
      },
    },

    // Google Translate via the free, keyless gtx endpoint (auto source detection).
    google: Object.assign({}, FREE_ENGINE, {
      async one(text) {
        const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto' +
          '&tl=' + encodeURIComponent(mapLang(GOOGLE_LANG, S().targetLang)) +
          '&dt=t&q=' + encodeURIComponent(text);
        const res = await request({ method: 'GET', url });
        if (res.status !== 200) throw httpError(res, 'google HTTP ' + res.status);
        let data = null;
        try { data = JSON.parse(res.responseText); } catch (e) { /* handled below */ }
        // data[0] = [[translatedChunk, originalChunk, …], …]; concatenate chunks.
        if (!data || !Array.isArray(data[0])) throw new ApiError('parse', 200, 'google: bad response');
        return data[0].map((seg) => (seg && seg[0]) || '').join('').trim();
      },
    }),

    // Microsoft Translator via the free Bing web endpoint, using a short-lived
    // token scraped from the translator page (cached until expiry, refreshed once).
    bing: Object.assign({}, FREE_ENGINE, {
      _auth: null,
      async auth(force) {
        const a = this._auth;
        if (!force && a && Date.now() - a.at < a.ttl) return a;
        const res = await request({ method: 'GET', url: 'https://www.bing.com/translator' });
        if (res.status !== 200) throw httpError(res, 'bing token HTTP ' + res.status);
        const html = res.responseText;
        const ig = /IG:"([^"]+)"/.exec(html);
        const iid = /data-iid="([^"]+)"/.exec(html);
        const p = /params_AbusePreventionHelper\s*=\s*\[\s*(\d+)\s*,\s*"([^"]+)"\s*,\s*(\d+)\s*\]/.exec(html);
        if (!ig || !p) throw new ApiError('parse', 200, 'bing: cannot parse auth params');
        return (this._auth = { ig: ig[1], iid: iid ? iid[1] : 'translator.5028',
          key: p[1], token: p[2], ttl: parseInt(p[3], 10) || 3600000, at: Date.now() });
      },
      async one(text, retried) {
        const a = await this.auth(false);
        const url = 'https://www.bing.com/ttranslatev3?isVertical=1&IG=' +
          encodeURIComponent(a.ig) + '&IID=' + encodeURIComponent(a.iid);
        const data = 'fromLang=auto-detect&to=' + encodeURIComponent(mapLang(BING_LANG, S().targetLang)) +
          '&text=' + encodeURIComponent(text) +
          '&token=' + encodeURIComponent(a.token) + '&key=' + encodeURIComponent(a.key);
        const res = await request({ method: 'POST', url,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, data });
        let json = null;
        try { json = JSON.parse(res.responseText); } catch (e) { /* handled below */ }
        const tr = json && json[0] && json[0].translations && json[0].translations[0];
        if (res.status === 200 && tr) return tr.text;
        // A stale token gives a 4xx or a {statusCode} object: refresh once, retry.
        if (!retried) { await this.auth(true); return this.one(text, true); }
        if (res.status !== 200) throw httpError(res, 'bing HTTP ' + res.status);
        throw new ApiError('parse', 200, 'bing: ' + String(res.responseText).slice(0, 200));
      },
    }),
  };

  const currentEngine = () => Engines[S().engine] || Engines.openai;

  // ===================================================================
  // 6. BATCHER (indexed-marker protocol + prompts)
  // ===================================================================

  const Batcher = {
    // Greedily pack pending units into batches bounded by the engine's pack size
    // and MAX_BATCH_CHARS. Free engines use packSize 1 (one request per paragraph).
    pack(units) {
      const batches = [];
      let current = [];
      let chars = 0;
      const packSize = currentEngine().packSize();
      for (const u of units) {
        const len = u.text.length;
        if (current.length &&
            (current.length >= packSize || chars + len > MAX_BATCH_CHARS)) {
          batches.push(current);
          current = [];
          chars = 0;
        }
        current.push(u);
        chars += len;
      }
      if (current.length) batches.push(current);
      return batches;
    },

    systemPrompt() {
      const tpl = S().systemPrompt || DEFAULT_SYSTEM_PROMPT;
      return tpl.replace(/\{\{to\}\}/g, langName(S().targetLang));
    },

    // Single-paragraph request: simple prompt, no markers, no parse-mismatch mode.
    singleMessages(text) {
      const tpl = S().userPromptTemplate || DEFAULT_SINGLE_PROMPT;
      const user = tpl
        .replace(/\{\{to\}\}/g, langName(S().targetLang))
        .replace(/\{\{text\}\}/g, text);
      return [
        { role: 'system', content: this.systemPrompt() },
        { role: 'user', content: user },
      ];
    },

    batchMessages(texts) {
      const header = BATCH_PROMPT_HEADER.replace(/\{\{to\}\}/g, langName(S().targetLang));
      const body = texts.map((t, i) => `%%${i + 1}%%\n${t}`).join('\n');
      return [
        { role: 'system', content: this.systemPrompt() },
        { role: 'user', content: header + '\n\n' + body },
      ];
    },

    // Returns Map<1-based index, translation> or null when the reply doesn't
    // contain exactly the requested marker set.
    parse(content, count) {
      const parts = content.split(/\s*%%\s*(\d+)\s*%%\s*/);
      const result = new Map();
      for (let i = 1; i < parts.length; i += 2) {
        const idx = parseInt(parts[i], 10);
        const text = (parts[i + 1] || '').trim();
        if (result.has(idx)) return null; // duplicate marker
        result.set(idx, text);
      }
      if (result.size !== count) return null;
      for (let i = 1; i <= count; i++) {
        if (!result.has(i) || !result.get(i)) return null;
      }
      return result;
    },
  };

  // ===================================================================
  // 7. SCHEDULER (viewport queue, rate limit, concurrency, retries)
  // ===================================================================

  const RateLimiter = {
    stamps: [],
    async acquire() {
      for (;;) {
        const now = Date.now();
        this.stamps = this.stamps.filter((t) => now - t < RATE_INTERVAL);
        if (this.stamps.length < RATE_LIMIT) {
          this.stamps.push(now);
          return;
        }
        await sleep(this.stamps[0] + RATE_INTERVAL - now + 10);
      }
    },
  };

  const Scheduler = {
    pending: [],     // units awaiting packing
    batchQueue: [],  // packed batches awaiting dispatch
    inFlight: 0,
    generation: 0,   // bumped on disable; stale responses are cached but not rendered
    paused: false,   // set on auth/network failure to stop hammering a dead endpoint
    flushTimer: null,

    enqueue(unit) {
      const cached = Cache.get(unit.text);
      if (cached !== undefined) {
        Renderer.setDone(unit.el, cached);
        return;
      }
      if (unit.prio === undefined) unit.prio = Scanner.priority(unit.el);
      this.pending.push(unit);
      clearTimeout(this.flushTimer);
      this.flushTimer = setTimeout(() => this.flush(), FLUSH_DEBOUNCE);
    },

    flush() {
      if (!this.pending.length) return;
      const units = this.pending.splice(0);
      // Higher-priority regions (article/main) pack into earlier batches so they
      // translate before chrome (header/footer/aside) queued in the same tick.
      units.sort((a, b) => a.prio - b.prio);
      this.batchQueue.push(...Batcher.pack(units));
      this.pump();
    },

    resume() {
      if (!this.paused) return;
      this.paused = false;
      UI.setButtonError(false);
      this.pump();
    },

    pauseOnFatal(err) {
      this.paused = true;
      UI.setButtonError(true);
      UI.toast(`翻譯暫停：${err.message}`, true);
    },

    clear() {
      this.pending = [];
      this.batchQueue = [];
      this.generation++;
    },

    pump() {
      while (!this.paused && this.inFlight < currentEngine().concurrency() && this.batchQueue.length) {
        const batch = this.batchQueue.shift();
        this.inFlight++;
        // The floating button stays static during translation (e-ink friendly).
        this.dispatch(batch).finally(() => {
          this.inFlight--;
          this.pump();
        });
      }
    },

    async dispatch(batch) {
      const gen = this.generation;
      batch.forEach((u) => Renderer.setLoading(u.el));
      const texts = batch.map((u) => u.text);

      let translations;
      try {
        translations = await this.requestWithRetry(() => currentEngine().translate(texts));
      } catch (err) {
        if (gen === this.generation) {
          batch.forEach((u) => Renderer.setError(u.el, err.message));
          if (err.kind === 'auth' || err.kind === 'network') this.pauseOnFatal(err);
        }
        return;
      }

      if (!Array.isArray(translations) || translations.length !== batch.length) {
        warn('engine returned wrong translation count', translations);
        if (gen === this.generation) {
          batch.forEach((u) => Renderer.setError(u.el, 'engine response mismatch'));
        }
        return;
      }
      batch.forEach((u, i) => this.deliver(u, (translations[i] || '').trim(), gen));
    },

    deliver(unit, translation, gen) {
      Cache.set(unit.text, translation);
      if (gen === this.generation) Renderer.setDone(unit.el, translation);
    },

    // Retry an engine call with backoff. Rate limiting happens per HTTP request
    // (inside request()), so this only adds the backoff/retry envelope.
    async requestWithRetry(fn) {
      let lastErr;
      for (let attempt = 0; attempt <= RETRY_BACKOFF.length; attempt++) {
        if (attempt > 0) {
          let wait = RETRY_BACKOFF[attempt - 1];
          if (lastErr && lastErr.kind === 'rate' && lastErr.retryAfter) {
            wait = Math.max(wait, lastErr.retryAfter * 1000);
          }
          await sleep(wait);
        }
        try {
          return await fn();
        } catch (err) {
          lastErr = err;
          if (err.kind === 'auth') throw err; // retrying won't fix a bad key
          log(`attempt ${attempt + 1} failed:`, err.kind, err.message);
        }
      }
      throw lastErr;
    },
  };

  // ===================================================================
  // 8. SCANNER (leaf-block translation units)
  // ===================================================================

  const Scanner = (() => {
    let nextId = 1;

    function isExcluded(el) {
      if (EXCLUDE_TAGS.has(el.tagName)) return true;
      if (el.getAttribute('aria-hidden') === 'true') return true;
      if (el.isContentEditable) return true;
      if (el.classList.contains('imtx-root') || el.classList.contains('imtx-translation')) return true;
      if (el.classList.contains('imtx-seg')) return true; // our own paragraph wrapper
      return false;
    }

    function hasBlockChild(el) {
      for (const child of el.children) {
        if (BLOCK_TAGS.has(child.tagName)) return true;
      }
      return false;
    }

    // The element's own translatable text: direct text nodes plus inline-element
    // descendants, but NOT block-level element children — each of those is its
    // own unit. Skips excluded subtrees and any translation wrapper we injected.
    // <br> becomes a space so loose paragraphs (e.g. Naver-style `text<br><br>text`
    // bodies) don't run together. For a plain leaf (no block children) this is
    // identical to its full text.
    function unitText(el) {
      let t = '';
      for (const n of el.childNodes) {
        if (n.nodeType === 3) { t += n.nodeValue; continue; }
        if (n.nodeType !== 1) continue;
        if (n.tagName === 'BR') { t += ' '; continue; }
        if (n.classList && (n.classList.contains('imtx-translation') || n.classList.contains('imtx-seg'))) continue;
        if (BLOCK_TAGS.has(n.tagName)) continue;
        t += n.textContent; // inline element (a, span, strong, …) belongs to this unit
      }
      return t.replace(/\s+/g, ' ').trim();
    }

    function maybeUnit(el, out) {
      const state = el.dataset.imtxState;
      if (state === 'done' || state === 'loading') return;
      const text = unitText(el);
      if (text.length < S().minTextLength) return;
      if (isAlreadyTarget(text)) return;
      if (!el.dataset.imtxId) el.dataset.imtxId = String(nextId++);
      el.dataset.imtxState = 'pending';
      out.push(el);
    }

    // Plain text of one paragraph segment (a run of inline nodes between <br>s).
    function segText(nodes) {
      return nodes.map((n) => n.textContent).join('').replace(/\s+/g, ' ').trim();
    }

    // Partition an element's direct children into paragraph runs: maximal spans of
    // inline content delimited by <br> runs, block children, or excluded subtrees.
    // Each returned segment is an array of consecutive inline nodes.
    function splitSegments(el) {
      const segs = [];
      let cur = [];
      const flush = () => { if (cur.length) segs.push(cur); cur = []; };
      for (const n of el.childNodes) {
        if (n.nodeType === 3) { // text: keep, but never start a run on pure whitespace
          if (n.nodeValue.trim() || cur.length) cur.push(n);
          continue;
        }
        if (n.nodeType !== 1) continue;
        if (n.tagName === 'BR') { flush(); continue; }
        if (BLOCK_TAGS.has(n.tagName) || EXCLUDE_TAGS.has(n.tagName)) { flush(); continue; }
        if (n.classList && (n.classList.contains('imtx-translation') ||
            n.classList.contains('imtx-seg') || n.classList.contains('imtx-root'))) { flush(); continue; }
        cur.push(n); // inline element belongs to the current paragraph
      }
      flush();
      return segs;
    }

    // Wrap a paragraph segment's nodes in a block <span> so it can carry its own
    // translation. Marked imtx-seg so the scanner treats it as a self-contained
    // unit and never re-wraps or double-counts it (see isExcluded).
    function wrapSegment(el, nodes) {
      const w = document.createElement('span');
      w.className = 'imtx-seg';
      el.insertBefore(w, nodes[0]);
      nodes.forEach((n) => w.appendChild(n));
      return w;
    }

    // Translate a unit-tag element. A block container whose loose text breaks into
    // 2+ paragraphs (Naver-style <br><br> bodies) is split so each paragraph is its
    // own bilingual unit; everything else is translated as a single unit.
    function collectUnit(el, out) {
      const state = el.dataset.imtxState;
      if (state === 'split') {
        // Already segmented: (re)collect its paragraph wrappers — e.g. after a
        // disable/enable cycle rewinds them from loading back to pending.
        for (const child of el.children) {
          if (child.classList && child.classList.contains('imtx-seg')) maybeUnit(child, out);
        }
        return;
      }
      if (state === 'done' || state === 'loading') return;
      if (SEGMENT_TAGS.has(el.tagName)) {
        const segs = splitSegments(el).filter((nodes) => {
          const t = segText(nodes);
          return t.length >= S().minTextLength && !isAlreadyTarget(t);
        });
        if (segs.length >= 2) {
          el.dataset.imtxState = 'split';
          for (const nodes of segs) maybeUnit(wrapSegment(el, nodes), out);
          return;
        }
      }
      maybeUnit(el, out);
    }

    // Translation priority from the nearest landmark ancestor (lower = sooner).
    function priority(el) {
      for (let n = el; n && n.nodeType === 1 && n !== document.body; n = n.parentElement) {
        const role = n.getAttribute && n.getAttribute('role');
        if (role === 'main' || role === 'article') return 0;
        if (role === 'complementary' || role === 'banner' ||
            role === 'contentinfo' || role === 'navigation') return 4;
        const p = PRIORITY_TAGS[n.tagName];
        if (p !== undefined) return p;
      }
      return PRIORITY_DEFAULT;
    }

    function walk(el, out) {
      if (el.nodeType !== 1 || isExcluded(el)) return;
      const blocky = hasBlockChild(el);
      // A leaf block, a block container with its own loose text, or a multi-
      // paragraph body — collectUnit decides whether to split per paragraph.
      if (UNIT_TAGS.has(el.tagName)) collectUnit(el, out);
      // Descend into block-level children so nested blocks each become their own
      // unit. A pure leaf (unit tag, no block children) is fully captured above,
      // so we don't recurse into its inline children. Segment wrappers created
      // just above are skipped by isExcluded.
      if (blocky || !UNIT_TAGS.has(el.tagName)) {
        for (const child of el.children) walk(child, out);
      }
    }

    return {
      // Scan a subtree and return translation-unit elements (idempotent:
      // done/loading units are skipped; pending/error units are re-collected).
      scan(root) {
        const out = [];
        if (root.nodeType !== 1) return out;
        if (root.closest && root.closest(EXCLUDE_CLOSEST)) return out;
        walk(root, out);
        log(`scan found ${out.length} units under`, root.tagName);
        return out;
      },
      unitText,
      priority,
    };
  })();

  // ===================================================================
  // 9. RENDERER (bilingual injection into page DOM)
  // ===================================================================

  GM_addStyle(`
    .imtx-translation {
      display: block;
      margin-top: 0.2em;
      unicode-bidi: isolate;
    }
    /* Each split paragraph is its own block so its translation sits beneath it. */
    .imtx-seg { display: block; }
    .imtx-translation.imtx-style-faded {
      opacity: 0.6;
    }
    .imtx-translation.imtx-style-italic {
      font-style: italic;
    }
    .imtx-translation.imtx-style-dashed {
      border-bottom: 1px dashed rgba(128, 128, 128, 0.66);
      padding-bottom: 0.1em;
    }
    .imtx-translation.imtx-style-dotted {
      text-decoration: underline dotted rgba(128, 128, 128, 0.8);
      text-underline-offset: 3px;
    }
    .imtx-translation.imtx-style-wavy {
      text-decoration: underline wavy rgba(128, 128, 128, 0.7);
      text-underline-offset: 3px;
    }
    .imtx-translation.imtx-style-quote {
      border-left: 3px solid rgba(128, 128, 128, 0.55);
      padding-left: 0.6em;
    }
    .imtx-translation.imtx-loading {
      opacity: 0.5;
    }
    .imtx-translation.imtx-failed {
      color: #d33;
      cursor: pointer;
      font-size: 0.85em;
    }
    html.imtx-hidden .imtx-translation { display: none !important; }
  `);

  const Renderer = {
    wrapper(el) {
      let w = null;
      for (const child of el.children) {
        if (child.classList.contains('imtx-translation')) { w = child; break; }
      }
      if (!w) {
        w = document.createElement('span');
        w.className = 'imtx-translation';
        w.setAttribute('lang', S().targetLang);
        w.setAttribute('translate', 'no');
        this.applyStyle(w);
        el.appendChild(w);
      }
      return w;
    },

    applyStyle(w) {
      DISPLAY_STYLES.forEach((s) => w.classList.remove('imtx-style-' + s));
      const style = S().displayStyle;
      if (style !== 'none') w.classList.add('imtx-style-' + style);
    },

    restyleAll() {
      document.querySelectorAll('.imtx-translation').forEach((w) => this.applyStyle(w));
    },

    setLoading(el) {
      el.dataset.imtxState = 'loading';
      const w = this.wrapper(el);
      w.classList.add('imtx-loading');
      w.classList.remove('imtx-failed');
      w.textContent = '···';
    },

    setDone(el, translation) {
      el.dataset.imtxState = 'done';
      const w = this.wrapper(el);
      w.classList.remove('imtx-loading', 'imtx-failed');
      w.textContent = translation; // textContent only — model output is never parsed as HTML
      w.onclick = null;
    },

    setError(el, message) {
      el.dataset.imtxState = 'error';
      const w = this.wrapper(el);
      w.classList.remove('imtx-loading');
      w.classList.add('imtx-failed');
      w.textContent = '⚠ 翻譯失敗 — 點擊重試';
      w.title = message || '';
      w.onclick = (e) => {
        e.stopPropagation();
        e.preventDefault();
        Scheduler.resume();
        Scheduler.enqueue({ el, text: Scanner.unitText(el) });
      };
    },
  };

  // ===================================================================
  // 10. UI (shadow DOM: floating button, settings panel, toast)
  // ===================================================================

  // Fields marked openaiOnly are hidden unless the OpenAI engine is selected
  // (Google/Microsoft are keyless and have no model/prompt/batch knobs).
  const SETTING_FIELDS = [
    { key: 'engine', label: 'Translation engine', type: 'select', options: ENGINE_OPTIONS,
      hint: 'Google and Microsoft are free and need no key. OpenAI needs an API key (or a compatible server URL).' },
    { key: 'apiBaseUrl', label: 'API Base URL', type: 'text', openaiOnly: true,
      hint: 'OpenAI-compatible base, including /v1 (e.g. http://localhost:8787/v1)' },
    { key: 'apiKeys', label: 'API Key(s)', type: 'password', openaiOnly: true,
      hint: 'Comma-separate multiple keys to rotate randomly' },
    { key: 'model', label: 'Model', type: 'text', openaiOnly: true },
    { key: 'targetLang', label: 'Target language', type: 'text', hint: 'BCP-47 code, e.g. zh-TW, en, ja' },
    { key: 'temperature', label: 'Temperature', type: 'number', step: '0.1', min: '0', max: '2', openaiOnly: true },
    { key: 'batchSize', label: 'Batch size', type: 'number', min: '1', max: '50', openaiOnly: true,
      hint: 'Paragraphs per request; 1 disables batching' },
    { key: 'maxConcurrent', label: 'Max concurrent requests', type: 'number', min: '1', max: '8', openaiOnly: true,
      hint: 'OpenAI only; Google and Microsoft use a fixed 5' },
    { key: 'minTextLength', label: 'Min paragraph length', type: 'number', min: '1', max: '500' },
    { key: 'displayStyle', label: 'Translation style', type: 'select', options: DISPLAY_STYLES },
    { key: 'idleDimSeconds', label: 'Dim button after (seconds)', type: 'number', min: '0', max: '600',
      hint: 'Idle seconds before the floating button dims; 0 = never dim' },
    { key: 'idleDimOpacity', label: 'Dimmed button opacity', type: 'number', step: '0.05', min: '0.05', max: '1',
      hint: '0.3 ≈ 70% transparent; 1 = fully opaque' },
    { key: 'hotkey', label: 'Toggle hotkey', type: 'text', hint: 'e.g. Alt+T' },
    { key: 'systemPrompt', label: 'System prompt override', type: 'textarea', openaiOnly: true,
      hint: 'Empty = built-in. {{to}} = target language. Batched requests need the %%N%% marker instruction.' },
    { key: 'userPromptTemplate', label: 'User prompt override', type: 'textarea', openaiOnly: true,
      hint: 'Single-paragraph requests only. {{to}}, {{text}}. Empty = built-in.' },
    { key: 'autoDomains', label: 'Always-translate domains', type: 'textarea', list: true, hint: 'One hostname per line' },
    { key: 'hiddenButtonDomains', label: 'Hide-button domains', type: 'textarea', list: true,
      hint: 'One hostname per line; the floating button is hidden on these sites' },
    { key: 'debug', label: 'Debug logging', type: 'checkbox' },
  ];

  const UI = (() => {
    let shadow = null;
    let btn = null;
    let panel = null;
    let toastEl = null;
    let toastTimer = null;
    let idleTimer = null;
    let dimmed = false;

    const CSS = `
      :host { all: initial; }
      * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
      /* No animations or transitions anywhere: this script targets e-ink
         devices, where every visual change forces a screen refresh. */
      .btn {
        position: fixed; right: 16px; bottom: 96px; z-index: 2147483646;
        width: 40px; height: 40px; border-radius: 50%;
        background: #fff; color: #000;
        border: 2px solid #000;
        box-shadow: 0 2px 8px rgba(0,0,0,0.18);
        font-size: 18px; line-height: 36px; text-align: center;
        cursor: pointer; user-select: none; touch-action: none;
      }
      /* Translation on/off does not recolor the button (no blue), so e-ink
         devices don't refresh the button on every toggle. */
      .btn.error::before {
        content: ""; position: absolute; top: 0; right: 0;
        width: 10px; height: 10px; border-radius: 50%;
        background: #e53935; border: 2px solid #fff;
      }

      .overlay {
        position: fixed; inset: 0; z-index: 2147483647;
        background: rgba(0,0,0,0.35);
        display: flex; align-items: center; justify-content: center;
      }
      .panel {
        background: #fff; color: #222; border-radius: 10px;
        width: min(520px, 92vw); max-height: 86vh; overflow-y: auto;
        padding: 20px 22px; box-shadow: 0 12px 40px rgba(0,0,0,0.3);
        font-size: 13px;
      }
      .panel h2 { margin: 0 0 14px; font-size: 16px; }
      .field { margin-bottom: 11px; }
      .field label { display: block; font-weight: 600; margin-bottom: 3px; }
      .field .hint { color: #888; font-size: 11px; margin-top: 2px; }
      .field input[type=text], .field input[type=password], .field input[type=number],
      .field select, .field textarea {
        width: 100%; padding: 6px 8px; border: 1px solid #ccc; border-radius: 5px;
        font-size: 13px; background: #fff; color: #222;
      }
      .field textarea { min-height: 52px; resize: vertical; }
      .row { display: flex; gap: 10px; margin-top: 16px; align-items: center; }
      .row button {
        padding: 7px 16px; border-radius: 6px; border: 1px solid #ccc;
        background: #f5f5f5; color: #222; cursor: pointer; font-size: 13px;
      }
      .row button.primary { background: #2962ff; border-color: #2962ff; color: #fff; }
      .test-result { font-size: 12px; flex: 1; }
      .test-result.ok { color: #2e7d32; }
      .test-result.bad { color: #c62828; }

      .toast {
        position: fixed; top: 18px; left: 50%; transform: translateX(-50%);
        z-index: 2147483647; max-width: 80vw;
        background: #323232; color: #fff; border-radius: 6px;
        padding: 9px 16px; font-size: 13px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.3);
        opacity: 0; pointer-events: none;
      }
      .toast.show { opacity: 1; }
      .toast.err { background: #b71c1c; }
    `;

    function mount() {
      const host = document.createElement('div');
      host.className = 'imtx-root';
      // Inline styles beat page rules like `div { display: none }`
      host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;display:block;z-index:2147483647;';
      shadow = host.attachShadow({ mode: 'closed' });

      const style = document.createElement('style');
      style.textContent = CSS;
      shadow.appendChild(style);

      btn = document.createElement('div');
      btn.className = 'btn';
      btn.textContent = '譯';
      btn.title = 'Immersive Translate (click: toggle, drag: move, right-click: settings)';
      const drag = makeDraggable(btn);
      if (S().buttonPos) applyPos(clampPos(S().buttonPos.right, S().buttonPos.bottom));
      btn.addEventListener('click', () => {
        if (drag.consume()) return; // a drag just ended, not a click
        if (btn.classList.contains('error')) {
          openSettings();
        } else {
          Controller.toggle();
        }
      });
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openSettings();
      });
      // Any interaction with the button wakes it from the dimmed idle state.
      ['pointerenter', 'pointerdown', 'pointermove'].forEach((ev) =>
        btn.addEventListener(ev, wakeButton));
      shadow.appendChild(btn);

      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      shadow.appendChild(toastEl);

      document.documentElement.appendChild(host);
      Store.onChange(wakeButton); // re-arm with new timeout/opacity after a save
      Store.onChange(refreshButtonVisibility); // hide/show when domains or target change
      dimButton();                // rest dimmed by default until first interaction
      refreshButtonVisibility();  // hide on opted-out sites / already-target pages
      if (S().debug) {
        window.__imtxBtn = btn; // test hooks (debug only)
        window.__imtxPriority = Scanner.priority;
      }
    }

    // Resting state: dimmed (unless dimming is disabled). Applied on load so the
    // button is unobtrusive until the user reaches for it.
    function dimButton() {
      clearTimeout(idleTimer);
      if (S().idleDimSeconds > 0) {
        btn.style.opacity = String(S().idleDimOpacity);
        dimmed = true;
      }
    }

    // Discrete opacity change only — no CSS transition, so e-ink refreshes once
    // per state change. Guarded so repeated pointer events (e.g. during a drag)
    // don't repaint when already bright.
    function wakeButton() {
      if (dimmed) {
        btn.style.opacity = '1';
        dimmed = false;
      }
      clearTimeout(idleTimer);
      const secs = S().idleDimSeconds;
      if (secs > 0) {
        idleTimer = setTimeout(() => {
          btn.style.opacity = String(S().idleDimOpacity);
          dimmed = true;
        }, secs * 1000);
      } else if (btn.style.opacity && btn.style.opacity !== '1') {
        btn.style.opacity = '1'; // dimming disabled → ensure fully opaque
      }
    }

    // The floating button is hidden on sites the user opted out of, and on pages
    // already written in the target language (nothing to translate). The hotkey
    // and userscript menu commands still work, so translation stays reachable.
    function shouldHideButton() {
      const list = S().hiddenButtonDomains || [];
      if (list.some((d) => domainMatches(location.hostname, d))) return true;
      return pageLangIsTarget();
    }

    function refreshButtonVisibility() {
      if (btn) btn.style.display = shouldHideButton() ? 'none' : '';
    }

    const DRAG_THRESHOLD = 5; // px of movement before a press counts as a drag

    function clampPos(right, bottom) {
      return {
        right: Math.min(Math.max(right, 0), window.innerWidth - 40),
        bottom: Math.min(Math.max(bottom, 0), window.innerHeight - 40),
      };
    }

    function applyPos(pos) {
      btn.style.right = pos.right + 'px';
      btn.style.bottom = pos.bottom + 'px';
    }

    function makeDraggable(el) {
      let active = false, dragged = false;
      let startX = 0, startY = 0, startRight = 0, startBottom = 0;
      el.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        active = true;
        dragged = false; // every fresh press resets stale drag state
        startX = e.clientX;
        startY = e.clientY;
        const r = el.getBoundingClientRect();
        startRight = window.innerWidth - r.right;
        startBottom = window.innerHeight - r.bottom;
        el.setPointerCapture(e.pointerId);
      });
      el.addEventListener('pointermove', (e) => {
        if (!active) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!dragged && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        dragged = true;
        applyPos(clampPos(startRight - dx, startBottom - dy));
      });
      const end = () => {
        if (!active) return;
        active = false;
        if (dragged) {
          const r = el.getBoundingClientRect();
          const pos = clampPos(window.innerWidth - r.right, window.innerHeight - r.bottom);
          applyPos(pos);
          Store.save({ buttonPos: pos });
        }
      };
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
      return {
        // True exactly once after a drag, so the trailing click is ignored.
        consume() {
          const d = dragged;
          dragged = false;
          return d;
        },
      };
    }

    function fieldHtml(f, value) {
      const id = 'f-' + f.key;
      let input;
      if (f.type === 'select') {
        // Options are trusted constants (strings, or {value,label} pairs).
        const opts = f.options.map((o) => {
          const val = typeof o === 'object' ? o.value : o;
          const label = typeof o === 'object' ? o.label : o;
          return `<option value="${val}"${val === value ? ' selected' : ''}>${label}</option>`;
        }).join('');
        input = `<select id="${id}">${opts}</select>`;
      } else if (f.type === 'textarea') {
        const v = f.list ? (value || []).join('\n') : (value || '');
        input = `<textarea id="${id}">${escapeHtml(v)}</textarea>`;
      } else if (f.type === 'checkbox') {
        input = `<input type="checkbox" id="${id}"${value ? ' checked' : ''}>`;
      } else {
        const extra = ['step', 'min', 'max']
          .filter((a) => f[a] !== undefined)
          .map((a) => ` ${a}="${f[a]}"`)
          .join('');
        input = `<input type="${f.type}" id="${id}" value="${escapeHtml(String(value ?? ''))}"${extra}>`;
      }
      const hint = f.hint ? `<div class="hint">${f.hint}</div>` : '';
      return `<div class="field" data-key="${f.key}"><label for="${id}">${f.label}</label>${input}${hint}</div>`;
    }

    function escapeHtml(s) {
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function readForm() {
      const patch = {};
      for (const f of SETTING_FIELDS) {
        const el = panel.querySelector('#f-' + f.key);
        if (f.type === 'checkbox') patch[f.key] = el.checked;
        else if (f.type === 'number') patch[f.key] = parseFloat(el.value) || DEFAULTS[f.key];
        else if (f.list) {
          patch[f.key] = el.value.split('\n').map((s) => s.trim()).filter(Boolean);
        } else patch[f.key] = el.value;
      }
      return patch;
    }

    function openSettings(hintMessage) {
      closeSettings();
      const s = S();
      const overlay = document.createElement('div');
      overlay.className = 'overlay';
      overlay.innerHTML = `
        <div class="panel">
          <h2>Immersive Translate — Settings</h2>
          ${hintMessage ? `<div class="field" style="color:#c62828">${hintMessage}</div>` : ''}
          ${SETTING_FIELDS.map((f) => fieldHtml(f, s[f.key])).join('')}
          <div class="row">
            <button class="primary" id="save">Save</button>
            <button id="test">Save &amp; Test connection</button>
            <button id="close">Close</button>
            <span class="test-result" id="test-result"></span>
          </div>
        </div>`;
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeSettings();
      });
      panel = overlay;
      shadow.appendChild(overlay);

      // OpenAI-only fields (key, model, prompts, …) show only for the OpenAI engine.
      const engineSelect = overlay.querySelector('#f-engine');
      const applyEngineVisibility = () => {
        SETTING_FIELDS.forEach((f) => {
          const wrap = f.openaiOnly && overlay.querySelector(`.field[data-key="${f.key}"]`);
          if (wrap) wrap.style.display = engineSelect.value === 'openai' ? '' : 'none';
        });
      };
      engineSelect.addEventListener('change', applyEngineVisibility);
      applyEngineVisibility();

      overlay.querySelector('#close').addEventListener('click', closeSettings);
      overlay.querySelector('#save').addEventListener('click', () => {
        Store.save(readForm());
        toast('Settings saved');
        closeSettings();
      });
      overlay.querySelector('#test').addEventListener('click', async () => {
        Store.save(readForm());
        const out = overlay.querySelector('#test-result');
        out.className = 'test-result';
        out.textContent = 'Testing…';
        try {
          const reply = await currentEngine().translate(['Hello, world!']);
          out.className = 'test-result ok';
          out.textContent = '✓ ' + String(reply[0] || '').trim().slice(0, 60);
          Scheduler.resume();
        } catch (err) {
          out.className = 'test-result bad';
          out.textContent = '✗ ' + err.message.slice(0, 120);
        }
      });
    }

    function closeSettings() {
      if (panel) {
        panel.remove();
        panel = null;
      }
    }

    function toast(msg, isError) {
      toastEl.textContent = msg;
      toastEl.className = 'toast show' + (isError ? ' err' : '');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toastEl.className = 'toast' + (isError ? ' err' : '');
      }, 3500);
    }

    return {
      mount,
      openSettings,
      toast,
      refreshButtonVisibility,
      setButtonOn(on) { btn.classList.toggle('on', on); },
      setButtonError(err) { btn.classList.toggle('error', err); },
    };
  })();

  // ===================================================================
  // 11. HOTKEY & MENU COMMANDS
  // ===================================================================

  function parseHotkey(str) {
    const parts = String(str || '').split('+').map((p) => p.trim().toLowerCase()).filter(Boolean);
    const key = parts.pop() || '';
    return {
      alt: parts.includes('alt'),
      ctrl: parts.includes('ctrl') || parts.includes('control'),
      shift: parts.includes('shift'),
      meta: parts.includes('meta') || parts.includes('cmd'),
      key,
    };
  }

  function installHotkey() {
    window.addEventListener('keydown', (e) => {
      const t = e.target;
      if (t && (t.isContentEditable ||
          ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      const hk = parseHotkey(S().hotkey);
      if (!hk.key) return;
      if (e.altKey !== hk.alt || e.ctrlKey !== hk.ctrl ||
          e.shiftKey !== hk.shift || e.metaKey !== hk.meta) return;
      // Compare e.code for letters (macOS Alt+letter yields a symbol in e.key)
      const matchesCode = hk.key.length === 1 && e.code === 'Key' + hk.key.toUpperCase();
      const matchesKey = e.key.toLowerCase() === hk.key;
      if (matchesCode || matchesKey) {
        e.preventDefault();
        Controller.toggle();
      }
    }, true);
  }

  function domainMatches(hostname, domain) {
    return hostname === domain || hostname.endsWith('.' + domain);
  }

  function installMenu() {
    GM_registerMenuCommand('Toggle translation', () => Controller.toggle());
    GM_registerMenuCommand('Always translate this site (on/off)', () => {
      const host = location.hostname;
      const list = S().autoDomains.slice();
      const idx = list.findIndex((d) => domainMatches(host, d));
      if (idx >= 0) {
        list.splice(idx, 1);
        UI.toast(`Auto-translate OFF for ${host}`);
      } else {
        list.push(host);
        UI.toast(`Auto-translate ON for ${host}`);
        if (!Controller.enabled) Controller.toggle();
      }
      Store.save({ autoDomains: list });
    });
    GM_registerMenuCommand('Hide floating button on this site (on/off)', () => {
      const host = location.hostname;
      const list = (S().hiddenButtonDomains || []).slice();
      const idx = list.findIndex((d) => domainMatches(host, d));
      if (idx >= 0) {
        list.splice(idx, 1);
        UI.toast(`Floating button shown for ${host}`);
      } else {
        list.push(host);
        UI.toast(`Floating button hidden for ${host}`);
      }
      Store.save({ hiddenButtonDomains: list }); // onChange refreshes button visibility
    });
    GM_registerMenuCommand('Settings', () => UI.openSettings());
  }

  // ===================================================================
  // 12. CONTROLLER (toggle state machine, observers, boot)
  // ===================================================================

  const Controller = {
    enabled: false,
    io: null,
    mo: null,
    mutationRoots: new Set(),
    mutationTimer: null,

    toggle() {
      this.enabled ? this.disable() : this.enable();
    },

    enable() {
      if (this.enabled) return;
      // Only the OpenAI engine needs credentials; Google/Microsoft are keyless.
      if (currentEngine().needsKey && !S().apiKeys.trim() && S().apiBaseUrl === DEFAULTS.apiBaseUrl) {
        UI.openSettings('Please configure an API key (or a custom server URL) first.');
        return;
      }
      this.enabled = true;
      UI.setButtonOn(true);
      document.documentElement.classList.remove('imtx-hidden');

      this.io = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          this.io.unobserve(entry.target);
          Scheduler.enqueue({ el: entry.target, text: Scanner.unitText(entry.target) });
        }
      }, { rootMargin: '200px 0px 400px 0px' });

      this.mo = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node.nodeType !== 1) continue;
            if (node.classList && (node.classList.contains('imtx-translation') ||
                node.classList.contains('imtx-seg') ||
                node.classList.contains('imtx-root'))) continue;
            this.mutationRoots.add(node);
          }
        }
        if (this.mutationRoots.size) {
          clearTimeout(this.mutationTimer);
          this.mutationTimer = setTimeout(() => {
            const roots = [...this.mutationRoots];
            this.mutationRoots.clear();
            roots.forEach((r) => r.isConnected && this.observeUnits(Scanner.scan(r)));
          }, MUTATION_DEBOUNCE);
        }
      });
      this.mo.observe(document.body, { childList: true, subtree: true });

      this.observeUnits(Scanner.scan(document.body));
      log('enabled');
    },

    disable() {
      if (!this.enabled) return;
      this.enabled = false;
      UI.setButtonOn(false);
      document.documentElement.classList.add('imtx-hidden');
      if (this.io) this.io.disconnect();
      if (this.mo) this.mo.disconnect();
      clearTimeout(this.mutationTimer);
      this.mutationRoots.clear();
      Scheduler.clear(); // bumps generation: in-flight replies land in cache only
      // Loading units' requests were dropped; rewind so re-enable re-queues them.
      document.querySelectorAll('[data-imtx-state="loading"]').forEach((el) => {
        el.dataset.imtxState = 'pending';
      });
      log('disabled');
    },

    observeUnits(units) {
      units.forEach((el) => this.io.observe(el));
    },

    boot() {
      Store.get();
      UI.mount();
      installMenu();
      installHotkey();
      Store.onChange(() => Renderer.restyleAll());
      const host = location.hostname;
      if (S().autoDomains.some((d) => domainMatches(host, d))) {
        log('auto-translate domain matched:', host);
        this.enable();
      }
    },
  };

  if (document.body) {
    Controller.boot();
  } else {
    window.addEventListener('DOMContentLoaded', () => Controller.boot());
  }
})();
