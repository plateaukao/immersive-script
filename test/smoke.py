#!/usr/bin/env python3
"""Headless smoke test: drives the real userscript (via GM shims in
test/harness.html) against the mock server.

Prereqs running locally:
    node test/mock-server.mjs              # port 8787
    python3 -m http.server 8000            # repo root

Run:
    python3 test/smoke.py
"""
import os
import sys
from playwright.sync_api import sync_playwright

# Defaults to the readable build; set IMTX_HARNESS to point at the minified
# harness (test/harness.min.html) to run the same checks against .min.user.js.
HARNESS = os.environ.get('IMTX_HARNESS', 'http://localhost:8000/test/harness.html')
PASS, FAIL = 0, 0


def check(name, cond):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f'  ok  {name}')
    else:
        FAIL += 1
        print(f'FAIL  {name}')


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    logs = []
    page.on('console', lambda m: logs.append(m.text))
    page.goto(HARNESS)

    # --- button rests dimmed by default (harness idleDimOpacity=0.25), no interaction yet ---
    check('button dimmed by default on load',
          page.evaluate("window.__imtxBtn && window.__imtxBtn.style.opacity") == '0.25')

    # --- toggle on via hotkey ---
    page.keyboard.press('Alt+KeyT')
    # 5 eligible units: the h1 heading plus t1-t4
    page.wait_for_function(
        "document.querySelectorAll('[data-imtx-state=done]').length >= 5", timeout=15000)

    texts = page.eval_on_selector_all(
        '.imtx-translation', 'els => els.map(e => e.textContent)')
    # 5 eligible units: the h1 heading plus t1-t4
    check('all 5 eligible units translated',
          len([t for t in texts if t.startswith('【譯】')]) == 5)
    check('translation text matches source (t1)',
          page.text_content('#t1 .imtx-translation') ==
          '【譯】The first English paragraph that is comfortably longer than the minimum text length threshold.')

    check('short list item skipped',
          page.eval_on_selector('#short', 'e => !e.dataset.imtxState'))
    check('Chinese paragraph skipped',
          page.eval_on_selector('#zh', 'e => !e.dataset.imtxState'))
    check('pre/code untouched',
          page.eval_on_selector('#code', 'e => e.querySelectorAll(".imtx-translation").length === 0'))

    # --- dynamic content (MutationObserver) ---
    page.evaluate("""() => {
        const p = document.createElement('p');
        p.id = 'dyn';
        p.textContent = 'A dynamically inserted paragraph that the MutationObserver must catch and translate.';
        document.getElementById('dyn-target').appendChild(p);
    }""")
    page.wait_for_function(
        "document.querySelector('#dyn .imtx-translation') !== null && "
        "document.querySelector('#dyn').dataset.imtxState === 'done'", timeout=10000)
    check('dynamic paragraph translated', True)
    check('dynamic paragraph translated exactly once',
          page.eval_on_selector('#dyn', 'e => e.querySelectorAll(".imtx-translation").length === 1'))

    check('display style class applied (wavy)',
          page.eval_on_selector('#t1 .imtx-translation',
                                'e => e.classList.contains("imtx-style-wavy")'))

    # --- idle dim (harness: idleDimSeconds=1, idleDimOpacity=0.25); button at default pos ---
    page.mouse.move(1244, 604)    # move over the button → wake it from the dimmed rest state
    page.wait_for_timeout(150)
    check('button opaque when interacted',
          page.evaluate("window.__imtxBtn.style.opacity") == '1')
    page.mouse.move(10, 10)       # move away and let it idle
    page.wait_for_timeout(1300)
    check('button re-dims after idle timeout',
          page.evaluate("window.__imtxBtn.style.opacity") == '0.25')

    # --- floating button drag (default pos: right 16, bottom 96, 40px, 1280x720 vp) ---
    page.mouse.move(1244, 604)
    page.mouse.down()
    page.mouse.move(640, 300, steps=10)
    page.mouse.up()
    pos = page.evaluate("JSON.parse(window.__gmStore['imtx:settings']).buttonPos")
    check('drag persists button position',
          pos is not None and abs(pos['right'] - 620) < 30 and abs(pos['bottom'] - 400) < 30)
    check('drag does not toggle translation',
          page.evaluate("!document.documentElement.classList.contains('imtx-hidden')"))
    page.mouse.click(640, 300)
    check('click at new position still toggles',
          page.evaluate("document.documentElement.classList.contains('imtx-hidden')"))
    page.mouse.click(640, 300)  # toggle back on

    # --- toggle off hides instantly, toggle on restores from DOM (no re-request) ---
    page.keyboard.press('Alt+KeyT')
    check('toggle off hides translations',
          page.evaluate("document.documentElement.classList.contains('imtx-hidden') && "
                        "getComputedStyle(document.querySelector('.imtx-translation')).display === 'none'"))
    page.keyboard.press('Alt+KeyT')
    check('toggle on restores translations',
          page.evaluate("!document.documentElement.classList.contains('imtx-hidden') && "
                        "getComputedStyle(document.querySelector('.imtx-translation')).display === 'block'"))

    # --- mixed-content body (Naver-style): bare text + <br>, sharing the element
    #     with a leading block child. The body is split into one bilingual unit per
    #     <br><br>-separated paragraph; the player block child is left untouched. ---
    page.goto('http://localhost:8000/test/pages/naver-style.html')
    page.wait_for_function("window.__imtxBtn", timeout=5000)
    page.keyboard.press('Alt+KeyT')
    page.wait_for_function(
        "document.querySelectorAll('#dic_area > .imtx-seg').length === 2 && "
        "[...document.querySelectorAll('#dic_area > .imtx-seg')]"
        ".every(s => s.dataset.imtxState === 'done')", timeout=10000)
    segs = page.eval_on_selector_all(
        '#dic_area > .imtx-seg > .imtx-translation', 'els => els.map(e => e.textContent)')
    check('Naver-style body split into 2 paragraph units', len(segs) == 2)
    check('first paragraph translated on its own',
          segs and segs[0] == '【譯】First bare paragraph of the article body, with no paragraph '
                              'wrapper, long enough to translate.')
    check('second paragraph translated on its own',
          len(segs) > 1 and segs[1] == '【譯】Second bare paragraph, separated only by line breaks, '
                                       'exactly like a Naver news body.')
    check('container marked split, not translated as one blob',
          page.eval_on_selector('#dic_area', "e => e.dataset.imtxState === 'split'"))
    check('player block child left untouched',
          page.eval_on_selector('#dic_area .player',
                                'e => e.querySelectorAll(".imtx-translation").length === 0'))

    # --- priority: article/main content outranks generic content and chrome ---
    check('priority: article content is highest (0)',
          page.evaluate("window.__imtxPriority(document.querySelector('#dic_area'))") == 0)
    check('priority: header/footer/aside content is lowest (4)',
          page.evaluate("""() => {
              const make = (tag) => { const w = document.createElement(tag);
                  const p = document.createElement('p'); p.textContent = 'x'; w.appendChild(p);
                  document.body.appendChild(w); const pr = window.__imtxPriority(p);
                  w.remove(); return pr; };
              return ['header', 'footer', 'aside'].every((t) => make(t) === 4);
          }""") is True)
    check('priority: unmarked content sits in the middle (3)',
          page.evaluate("""() => {
              const d = document.createElement('div');
              const p = document.createElement('p'); p.textContent = 'x'; d.appendChild(p);
              document.body.appendChild(d); const pr = window.__imtxPriority(p);
              d.remove(); return pr;
          }""") == 3)

    browser.close()

print(f'\n{PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
