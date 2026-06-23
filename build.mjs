// Build the distributable minified userscript from the readable source.
//
//   npm install   # once, to fetch terser
//   npm run build # regenerate immersive-translate-openai.min.user.js
//
// The readable .user.js stays the source of truth; this only produces the
// smaller, faster-to-parse .min.user.js (handy on e-ink readers). The
// UserScript metadata block is copied verbatim — never minified — except that
// the min build's @updateURL/@downloadURL are pointed at the min file so it
// self-updates from its own URL. A matching test/harness.min.html is emitted
// so the smoke test can exercise the minified build (see README).

import { readFileSync, writeFileSync } from 'node:fs';
import { minify } from 'terser';

const SRC = 'immersive-translate-openai.user.js';
const OUT = 'immersive-translate-openai.min.user.js';
const HARNESS = 'test/harness.html';
const HARNESS_MIN = 'test/harness.min.html';

const source = readFileSync(SRC, 'utf8');

// Split off the // ==UserScript== … // ==/UserScript== metadata block; userscript
// managers parse it literally, so it must survive byte-for-byte (minus the URL
// rewrite below). Only the IIFE body that follows is minified.
const header = source.match(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\n/);
if (!header) throw new Error('UserScript metadata block not found in ' + SRC);
const body = source.slice(header.index + header[0].length);
const minHeader = header[0].replace(new RegExp(SRC.replace(/\./g, '\\.'), 'g'), OUT);

const { code, error } = await minify(body, {
  compress: true,
  mangle: true,                 // local names only; property names are left intact
  format: { comments: false },  // header is prepended separately
});
if (error) throw error;

writeFileSync(OUT, minHeader + '\n' + code + '\n');

// Keep the minified test harness in lockstep with the readable one.
writeFileSync(HARNESS_MIN,
  readFileSync(HARNESS, 'utf8').replace('../' + SRC, '../' + OUT));

const before = body.length, after = code.length;
console.log(`${OUT}  ${(minHeader.length + after + 1)} bytes ` +
  `(body ${before} → ${after}, ${(100 * (1 - after / before)).toFixed(1)}% smaller)`);
