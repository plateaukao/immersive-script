# Immersive Translate (OpenAI)

A single-file userscript for Tampermonkey / Violentmonkey that provides **immersive (bilingual) web page translation**: the translation is inserted directly below each original paragraph, so you read both side by side. Pick a translation engine from a dropdown in settings:

- **Google Translate** — free, no API key.
- **Microsoft Translator** (Bing) — free, no API key.
- **OpenAI API or any OpenAI-compatible server** (LM Studio, llama.cpp `llama-server`, Ollama, OpenRouter, self-hosted proxies, …) — needs an API key (or a local server URL).

Google and Microsoft work out of the box with no signup, so you can start translating immediately even without an OpenAI key.

Inspired by the open-source [Immersive Translate userscript](https://greasyfork.org/scripts/523378), rebuilt from scratch around a single, pluggable translation pipeline.

## Features

- Three engines in a dropdown — Google Translate and Microsoft Translator (both free, keyless) or any OpenAI-compatible chat endpoint
- Bilingual display — original stays fully formatted, plain-text translation appears below it
- Configurable OpenAI endpoint: base URL, model, API key(s), temperature, prompts (key-free engines need none of this)
- Lazy translation — only paragraphs near the viewport are translated (IntersectionObserver)
- Dynamic content support — SPAs and infinite scroll handled via MutationObserver
- Multi-paragraph batching (OpenAI) — up to 10 paragraphs per request using `%%N%%` markers, with automatic per-paragraph fallback if the model mangles the markers; the free engines translate one paragraph per request
- In-memory translation cache — toggling off/on or SPA re-renders cost zero extra requests
- Rate limiting (5 req / 1.3 s), concurrency cap, retries with backoff, `Retry-After` support
- Skips code blocks, `pre`, form controls, contenteditable, navigation, and already-Chinese text
- Per-site auto-translate list, hotkey (`Alt+T` by default), draggable floating button (position remembered), GM menu commands
- Smart floating button — hidden automatically on pages already in the target language (nothing to translate), and hideable per-site from the menu; the hotkey and menu commands keep working when it's hidden
- Translation display styles: plain, faded, italic, dashed underline, dotted underline, wavy underline, or quote-style left border
- E-ink friendly: no animations or transitions anywhere; the floating button stays completely static during translation, has a solid black border for readability, and dims after an idle timeout (both the delay and dimmed opacity are configurable)

## Install

Two equivalent builds ship in the repo — install **one**:

- **`immersive-translate-openai.min.user.js`** — minified (~half the size, faster to parse; nicer on e-ink readers). Recommended for everyday use. Self-updates from its own URL.
- **`immersive-translate-openai.user.js`** — the readable source. Install this if you want to read or tweak the code; it's also what you edit during development.

Both are functionally identical and built from the same source (see [Build](#build)).

1. Install [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
2. Open one of the `*.user.js` files in the manager (drag the file in, or paste into a new script).
3. Visit any page → click the floating **譯** button (bottom right) → toggle translation on.
4. The default engine is **Google Translate** — free and keyless, so translation works immediately with no setup. To use OpenAI instead, right-click the button → Settings → set **Translation engine** to **OpenAI / compatible**, enter your API key, and click **Save & Test connection**.

## Usage

| Action | How |
|---|---|
| Toggle translation | Click the floating button, press `Alt+T`, or use the userscript menu |
| Open settings | Right-click the floating button, or userscript menu → Settings |
| Always translate a site | Userscript menu → "Always translate this site (on/off)" |
| Hide the floating button on a site | Userscript menu → "Hide floating button on this site (on/off)" |
| Move the floating button | Drag it anywhere; the position is saved |
| Retry a failed paragraph | Click the red "翻譯失敗 — 點擊重試" line |

Settings of note:

- **Translation engine** — `Google Translate` and `Microsoft Translator` are free and need no key; the OpenAI-only fields below (base URL, key, model, temperature, batch size, prompts) are hidden when one of them is selected. `OpenAI / compatible` needs an API key (or a local server URL).
- **API Base URL** (OpenAI) — include the `/v1` (e.g. `https://api.openai.com/v1`, `http://localhost:1234/v1`). The script appends `/chat/completions`.
- **API Key(s)** (OpenAI) — comma-separate several keys to rotate randomly per request.
- **Batch size** (OpenAI) — paragraphs per request; set to `1` to disable batching entirely.
- **Target language** — BCP-47 code; default `zh-TW`. When the target is Chinese, pages already in Chinese are skipped automatically. When a page's declared language (`<html lang>` or a content-language meta) shares its primary subtag with the target (e.g. an `en-GB` page with target `en`), the floating button is hidden — there's nothing to translate.
- **Hide-button domains** — one hostname per line; the floating button is hidden on these sites (also toggleable from the userscript menu). The hotkey and menu commands still work.
- **Translation style** — `none` | `faded` (dimmed) | `italic` | `dashed` | `dotted` | `wavy` | `quote` (left border).
- **Dim button after / Dimmed button opacity** — the floating button rests dimmed by default (so it's unobtrusive) and stays dimmed; any interaction restores full opacity, after which it re-dims once the idle seconds elapse (`0` = never dim). `0.3` opacity ≈ 70% transparent.

## Development & Testing

The readable `.user.js` is the source of truth — edit it directly; no build step is needed to develop. For a fast edit loop:

```bash
cd immersive_script
python3 -m http.server 8000
# install from http://localhost:8000/immersive-translate-openai.user.js
# Tampermonkey will offer to track the external file on each save
```

### Build

The minified `immersive-translate-openai.min.user.js` is generated from the source with [terser](https://terser.org/). After editing the source, regenerate it:

```bash
npm install        # once, to fetch terser (dev-only; node_modules is git-ignored)
npm run build      # writes immersive-translate-openai.min.user.js
```

The build copies the `// ==UserScript==` metadata block verbatim (only repointing the min build's `@updateURL`/`@downloadURL` at itself) and minifies just the script body — local names are mangled, but property names, strings, and the prompt/marker protocol are left intact. It also emits `test/harness.min.html` so the smoke test can run against the minified build. **Commit the regenerated `.min.user.js`** so the raw-GitHub download URL stays in sync with the source.

### Token-free testing with the mock server

```bash
node test/mock-server.mjs            # http://localhost:8787/v1
```

The mock is OpenAI-only, so set **Translation engine** to `OpenAI / compatible`, API Base URL to `http://localhost:8787/v1`, and key to `test`. The mock echoes each segment back as `【譯】<original>`. (The Google and Microsoft engines call their real public endpoints — test those against live pages, not the mock.) Failure modes:

```bash
MODE=mismatch node test/mock-server.mjs   # drops a %%N%% marker → exercises per-paragraph fallback
MODE=429      node test/mock-server.mjs   # rate limit + Retry-After handling
MODE=500      node test/mock-server.mjs   # retries then per-paragraph error state
MODE=slow     node test/mock-server.mjs   # 3s latency → spinner & concurrency cap visible
MODE=badkey   node test/mock-server.mjs   # 401 unless key is exactly "test" → paused queue + toast
```

To validate real prompt/translation quality without paid tokens, point the base URL at a local model server (LM Studio `http://localhost:1234/v1`, llama.cpp `http://localhost:8080/v1`).

### Automated smoke test

`test/harness.html` loads the real userscript in a plain page with `GM_*` shims (storage, `GM_xmlhttpRequest` via `fetch`), so the full pipeline can run headlessly. With Playwright for Python installed:

```bash
node test/mock-server.mjs &          # port 8787
python3 -m http.server 8000 &        # repo root
python3 test/smoke.py                # detection, batching, exclusions,
                                     # MutationObserver, toggle hide/restore, …
```

Running it with `MODE=mismatch` on the mock additionally exercises the per-paragraph fallback path.

To run the same checks against the minified build (after `npm run build`):

```bash
IMTX_HARNESS=http://localhost:8000/test/harness.min.html python3 test/smoke.py
```

### Test pages

Serve the repo (`python3 -m http.server 8000`) and open:

- `test/pages/static-article.html` — detection, batching, lazy scroll translation, inline formatting, CJK skip, nav exclusion
- `test/pages/spa.html` — MutationObserver pickup of injected/replaced content, cache behavior on view switches
- `test/pages/code-blocks.html` — `pre`/`code`/`textarea`/`input`/contenteditable exclusions

## Known v1 limitations

- Translations are plain text; inline formatting (links, bold) is not reproduced inside the translation (the formatted original sits one line above).
- Mixed-content blocks (e.g. `<li>text<ul>…</ul></li>`) translate the nested list but skip the bare text directly inside the parent.
- Simplified-Chinese pages are also skipped when the target is `zh-TW` (the language heuristic detects "Chinese", not the script variant).
- Top frame only (`@noframes`).

## License

MIT
