#!/usr/bin/env python3
"""Headless smoke test: drives the real userscript (via GM shims in
test/harness.html) against the mock server.

Prereqs running locally:
    node test/mock-server.mjs              # port 8787
    python3 -m http.server 8000            # repo root

Run:
    python3 test/smoke.py
"""
import sys
from playwright.sync_api import sync_playwright

HARNESS = 'http://localhost:8000/test/harness.html'
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

    # --- toggle off hides instantly, toggle on restores from DOM (no re-request) ---
    page.keyboard.press('Alt+KeyT')
    check('toggle off hides translations',
          page.evaluate("document.documentElement.classList.contains('imtx-hidden') && "
                        "getComputedStyle(document.querySelector('.imtx-translation')).display === 'none'"))
    page.keyboard.press('Alt+KeyT')
    check('toggle on restores translations',
          page.evaluate("!document.documentElement.classList.contains('imtx-hidden') && "
                        "getComputedStyle(document.querySelector('.imtx-translation')).display === 'block'"))

    browser.close()

print(f'\n{PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
