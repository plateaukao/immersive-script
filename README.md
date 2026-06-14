# Immersive Translate (OpenAI)

A single-file userscript for Tampermonkey / Violentmonkey that provides **immersive (bilingual) web page translation**: the translation is inserted directly below each original paragraph, so you read both side by side. Powered exclusively by the **OpenAI API or any OpenAI-compatible server** (LM Studio, llama.cpp `llama-server`, Ollama, OpenRouter, self-hosted proxies, …).

Inspired by the open-source [Immersive Translate userscript](https://greasyfork.org/scripts/523378), rebuilt from scratch around a single engine.

## Features

- Bilingual display — original stays fully formatted, plain-text translation appears below it
- Any OpenAI-compatible endpoint: configurable base URL, model, API key(s), temperature, prompts
- Lazy translation — only paragraphs near the viewport are translated (IntersectionObserver)
- Dynamic content support — SPAs and infinite scroll handled via MutationObserver
- Multi-paragraph batching — up to 10 paragraphs per API request using `%%N%%` markers, with automatic per-paragraph fallback if the model mangles the markers
- In-memory translation cache — toggling off/on or SPA re-renders cost zero extra requests
- Rate limiting (5 req / 1.3 s), concurrency cap, retries with backoff, `Retry-After` support
- Skips code blocks, `pre`, form controls, contenteditable, navigation, and already-Chinese text
- Per-site auto-translate list, hotkey (`Alt+T` by default), draggable floating button (position remembered), GM menu commands
- Smart floating button — hidden automatically on pages already in the target language (nothing to translate), and hideable per-site from the menu; the hotkey and menu commands keep working when it's hidden
- Translation display styles: plain, faded, italic, dashed underline, dotted underline, wavy underline, or quote-style left border
- E-ink friendly: no animations or transitions anywhere; the floating button stays completely static during translation, has a solid black border for readability, and dims after an idle timeout (both the delay and dimmed opacity are configurable)

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
2. Open `immersive-translate-openai.user.js` in the manager (drag the file in, or paste into a new script).
3. Visit any page → click the floating **譯** button (bottom right) → the settings panel opens on first use.
4. Enter your API key (and base URL/model if not using OpenAI), click **Save & Test connection**.

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

- **API Base URL** — include the `/v1` (e.g. `https://api.openai.com/v1`, `http://localhost:1234/v1`). The script appends `/chat/completions`.
- **API Key(s)** — comma-separate several keys to rotate randomly per request.
- **Batch size** — paragraphs per request; set to `1` to disable batching entirely.
- **Target language** — BCP-47 code; default `zh-TW`. When the target is Chinese, pages already in Chinese are skipped automatically. When a page's declared language (`<html lang>` or a content-language meta) shares its primary subtag with the target (e.g. an `en-GB` page with target `en`), the floating button is hidden — there's nothing to translate.
- **Hide-button domains** — one hostname per line; the floating button is hidden on these sites (also toggleable from the userscript menu). The hotkey and menu commands still work.
- **Translation style** — `none` | `faded` (dimmed) | `italic` | `dashed` | `dotted` | `wavy` | `quote` (left border).
- **Dim button after / Dimmed button opacity** — the floating button rests dimmed by default (so it's unobtrusive) and stays dimmed; any interaction restores full opacity, after which it re-dims once the idle seconds elapse (`0` = never dim). `0.3` opacity ≈ 70% transparent.

## Development & Testing

No build step — edit the `.user.js` directly. For a fast edit loop:

```bash
cd immersive_script
python3 -m http.server 8000
# install from http://localhost:8000/immersive-translate-openai.user.js
# Tampermonkey will offer to track the external file on each save
```

### Token-free testing with the mock server

```bash
node test/mock-server.mjs            # http://localhost:8787/v1
```

In settings, set API Base URL to `http://localhost:8787/v1` and key to `test`. The mock echoes each segment back as `【譯】<original>`. Failure modes:

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
python3 test/smoke.py                # 9 checks: detection, batching, exclusions,
                                     # MutationObserver, toggle hide/restore
```

Running it with `MODE=mismatch` on the mock additionally exercises the per-paragraph fallback path.

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
