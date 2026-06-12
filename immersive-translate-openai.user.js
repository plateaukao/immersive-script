// ==UserScript==
// @name         Immersive Translate (OpenAI)
// @namespace    https://github.com/plateaukao/immersive-script
// @homepageURL  https://github.com/plateaukao/immersive-script
// @supportURL   https://github.com/plateaukao/immersive-script/issues
// @version      0.1.1
// @description  Bilingual immersive web page translation via the OpenAI API or any OpenAI-compatible server
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
  const FLUSH_DEBOUNCE = 150;     // ms, viewport queue
  const MUTATION_DEBOUNCE = 300;  // ms, dynamic content re-scan

  const DEFAULTS = {
    schemaVersion: 1,
    apiBaseUrl: 'https://api.openai.com/v1', // full base incl. /v1; /chat/completions is appended
    apiKeys: '',                  // comma-separated; random rotation per request
    model: 'gpt-4o-mini',
    targetLang: 'zh-TW',
    temperature: 0,
    systemPrompt: '',             // empty = built-in default; supports {{to}}
    userPromptTemplate: '',       // empty = built-in; single-paragraph requests only; {{to}}, {{text}}
    batchSize: 10,                // max segments per chat request (1 disables batching)
    maxConcurrent: 2,
    minTextLength: 18,
    displayStyle: 'none',         // none | dashed | quote
    hotkey: 'Alt+T',
    autoDomains: [],              // hostnames, suffix-matched ("example.com" covers "www.example.com")
    debug: false,
  };

  const DEFAULT_SYSTEM_PROMPT =
    'You are a translation engine. You translate text and never explain, answer questions, or add commentary. Preserve all %%N%% marker lines exactly as given.';
  const DEFAULT_SINGLE_PROMPT =
    'Translate the text below to {{to}}:\n\n{{text}}';
  const BATCH_PROMPT_HEADER =
    'Translate each numbered segment below into {{to}}. Reply with the same %%N%% marker line before each translated segment, in the same order, and nothing else.';

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
    '[aria-hidden="true"],[contenteditable=""],[contenteditable="true"],.imtx-root,.imtx-translation';

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
        return `${S().targetLang}|${S().model}|${text}`;
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
  // 5. TRANSLATOR (OpenAI-compatible chat client)
  // ===================================================================

  class ApiError extends Error {
    constructor(kind, status, message, retryAfter) {
      super(message);
      this.kind = kind; // auth | rate | server | network | parse
      this.status = status;
      this.retryAfter = retryAfter; // seconds, from Retry-After header if present
    }
  }

  const Translator = {
    pickKey() {
      const keys = S().apiKeys.split(',').map((k) => k.trim()).filter(Boolean);
      if (!keys.length) return '';
      return keys[Math.floor(Math.random() * keys.length)];
    },

    chat(messages) {
      const url = S().apiBaseUrl.replace(/\/+$/, '') + '/chat/completions';
      const key = this.pickKey();
      const headers = { 'Content-Type': 'application/json' };
      if (key) headers.Authorization = 'Bearer ' + key;
      const body = JSON.stringify({
        model: S().model,
        temperature: S().temperature,
        stream: false,
        messages,
      });
      log('request', url, messages);
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'POST',
          url,
          headers,
          data: body,
          timeout: REQUEST_TIMEOUT,
          onload(res) {
            let json = null;
            try {
              json = JSON.parse(res.responseText);
            } catch (e) { /* handled below */ }
            if (res.status === 200) {
              const content = json && json.choices && json.choices[0] &&
                json.choices[0].message && json.choices[0].message.content;
              if (typeof content === 'string') return resolve(content);
              return reject(new ApiError('parse', 200, 'unexpected response shape: ' +
                String(res.responseText).slice(0, 300)));
            }
            const apiMsg = (json && json.error && json.error.message) ||
              String(res.responseText).slice(0, 300) || ('HTTP ' + res.status);
            if (res.status === 401 || res.status === 403) {
              return reject(new ApiError('auth', res.status, apiMsg));
            }
            if (res.status === 429) {
              const m = /retry-after:\s*(\d+)/i.exec(res.responseHeaders || '');
              return reject(new ApiError('rate', 429, apiMsg, m ? parseInt(m[1], 10) : undefined));
            }
            reject(new ApiError('server', res.status, apiMsg));
          },
          onerror() {
            reject(new ApiError('network', 0, 'network error (check API base URL / @connect)'));
          },
          ontimeout() {
            reject(new ApiError('network', 0, 'request timed out'));
          },
        });
      });
    },
  };

  // ===================================================================
  // 6. BATCHER (indexed-marker protocol + prompts)
  // ===================================================================

  const Batcher = {
    // Greedily pack pending units into batches bounded by batchSize and MAX_BATCH_CHARS.
    pack(units) {
      const batches = [];
      let current = [];
      let chars = 0;
      for (const u of units) {
        const len = u.text.length;
        if (current.length &&
            (current.length >= S().batchSize || chars + len > MAX_BATCH_CHARS)) {
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

    batchMessages(units) {
      const header = BATCH_PROMPT_HEADER.replace(/\{\{to\}\}/g, langName(S().targetLang));
      const body = units.map((u, i) => `%%${i + 1}%%\n${u.text}`).join('\n');
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
      this.pending.push(unit);
      clearTimeout(this.flushTimer);
      this.flushTimer = setTimeout(() => this.flush(), FLUSH_DEBOUNCE);
    },

    flush() {
      if (!this.pending.length) return;
      const units = this.pending.splice(0);
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
      while (!this.paused && this.inFlight < S().maxConcurrent && this.batchQueue.length) {
        const batch = this.batchQueue.shift();
        this.inFlight++;
        UI.setButtonBusy(true);
        this.dispatch(batch).finally(() => {
          this.inFlight--;
          if (this.inFlight === 0) UI.setButtonBusy(false);
          this.pump();
        });
      }
    },

    async dispatch(batch) {
      const gen = this.generation;
      batch.forEach((u) => Renderer.setLoading(u.el));
      const single = batch.length === 1;
      const messages = single
        ? Batcher.singleMessages(batch[0].text)
        : Batcher.batchMessages(batch);

      let content;
      try {
        content = await this.requestWithRetry(messages);
      } catch (err) {
        if (gen === this.generation) {
          batch.forEach((u) => Renderer.setError(u.el, err.message));
          if (err.kind === 'auth' || err.kind === 'network') this.pauseOnFatal(err);
        }
        return;
      }

      if (single) {
        this.deliver(batch[0], content.trim(), gen);
        return;
      }
      const parsed = Batcher.parse(content, batch.length);
      if (parsed) {
        batch.forEach((u, i) => this.deliver(u, parsed.get(i + 1), gen));
      } else {
        // Marker mismatch: silently fall back to one request per paragraph.
        warn('batch marker mismatch, falling back to per-paragraph. Raw reply:', content);
        if (gen === this.generation) {
          this.batchQueue.unshift(...batch.map((u) => [u]));
        }
      }
    },

    deliver(unit, translation, gen) {
      Cache.set(unit.text, translation);
      if (gen === this.generation) Renderer.setDone(unit.el, translation);
    },

    async requestWithRetry(messages) {
      let lastErr;
      for (let attempt = 0; attempt <= RETRY_BACKOFF.length; attempt++) {
        if (attempt > 0) {
          let wait = RETRY_BACKOFF[attempt - 1];
          if (lastErr && lastErr.kind === 'rate' && lastErr.retryAfter) {
            wait = Math.max(wait, lastErr.retryAfter * 1000);
          }
          await sleep(wait);
        }
        await RateLimiter.acquire();
        try {
          return await Translator.chat(messages);
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
      return false;
    }

    function hasBlockChild(el) {
      for (const child of el.children) {
        if (BLOCK_TAGS.has(child.tagName)) return true;
      }
      return false;
    }

    // Unit text, excluding any translation wrapper we previously injected.
    function unitText(el) {
      let t = '';
      for (const n of el.childNodes) {
        if (n.nodeType === 1 && n.classList && n.classList.contains('imtx-translation')) continue;
        t += n.textContent;
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

    function walk(el, out) {
      if (el.nodeType !== 1 || isExcluded(el)) return;
      if (!hasBlockChild(el) && UNIT_TAGS.has(el.tagName)) {
        maybeUnit(el, out);
        return;
      }
      for (const child of el.children) walk(child, out);
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
    .imtx-translation.imtx-style-dashed {
      border-bottom: 1px dashed rgba(128, 128, 128, 0.66);
      padding-bottom: 0.1em;
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
      w.classList.remove('imtx-style-dashed', 'imtx-style-quote');
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

  const SETTING_FIELDS = [
    { key: 'apiBaseUrl', label: 'API Base URL', type: 'text',
      hint: 'OpenAI-compatible base, including /v1 (e.g. http://localhost:8787/v1)' },
    { key: 'apiKeys', label: 'API Key(s)', type: 'password',
      hint: 'Comma-separate multiple keys to rotate randomly' },
    { key: 'model', label: 'Model', type: 'text' },
    { key: 'targetLang', label: 'Target language', type: 'text', hint: 'BCP-47 code, e.g. zh-TW, en, ja' },
    { key: 'temperature', label: 'Temperature', type: 'number', step: '0.1', min: '0', max: '2' },
    { key: 'batchSize', label: 'Batch size', type: 'number', min: '1', max: '50',
      hint: 'Paragraphs per request; 1 disables batching' },
    { key: 'maxConcurrent', label: 'Max concurrent requests', type: 'number', min: '1', max: '8' },
    { key: 'minTextLength', label: 'Min paragraph length', type: 'number', min: '1', max: '500' },
    { key: 'displayStyle', label: 'Translation style', type: 'select', options: ['none', 'dashed', 'quote'] },
    { key: 'hotkey', label: 'Toggle hotkey', type: 'text', hint: 'e.g. Alt+T' },
    { key: 'systemPrompt', label: 'System prompt override', type: 'textarea',
      hint: 'Empty = built-in. {{to}} = target language. Batched requests need the %%N%% marker instruction.' },
    { key: 'userPromptTemplate', label: 'User prompt override', type: 'textarea',
      hint: 'Single-paragraph requests only. {{to}}, {{text}}. Empty = built-in.' },
    { key: 'autoDomains', label: 'Always-translate domains', type: 'textarea', hint: 'One hostname per line' },
    { key: 'debug', label: 'Debug logging', type: 'checkbox' },
  ];

  const UI = (() => {
    let shadow = null;
    let btn = null;
    let panel = null;
    let toastEl = null;
    let toastTimer = null;

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
        cursor: pointer; user-select: none;
      }
      .btn.on { background: #2962ff; color: #fff; border-color: #2962ff; }
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
      btn.title = 'Immersive Translate (click: toggle, right-click: settings)';
      btn.addEventListener('click', () => {
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
      shadow.appendChild(btn);

      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      shadow.appendChild(toastEl);

      document.documentElement.appendChild(host);
    }

    function fieldHtml(f, value) {
      const id = 'f-' + f.key;
      let input;
      if (f.type === 'select') {
        const opts = f.options
          .map((o) => `<option value="${o}"${o === value ? ' selected' : ''}>${o}</option>`)
          .join('');
        input = `<select id="${id}">${opts}</select>`;
      } else if (f.type === 'textarea') {
        const v = f.key === 'autoDomains' ? (value || []).join('\n') : (value || '');
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
      return `<div class="field"><label for="${id}">${f.label}</label>${input}${hint}</div>`;
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
        else if (f.key === 'autoDomains') {
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
          <h2>Immersive Translate (OpenAI) — Settings</h2>
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
          const reply = await Translator.chat(Batcher.singleMessages('Hello, world!'));
          out.className = 'test-result ok';
          out.textContent = '✓ ' + reply.trim().slice(0, 60);
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
      setButtonOn(on) { btn.classList.toggle('on', on); },
      setButtonBusy(busy) {
        btn.classList.toggle('busy', busy);
        btn.textContent = busy ? '…' : '譯'; // static indicator, no spinner
      },
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
      if (!S().apiKeys.trim() && S().apiBaseUrl === DEFAULTS.apiBaseUrl) {
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
      UI.setButtonBusy(false);
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
