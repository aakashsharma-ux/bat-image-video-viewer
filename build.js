#!/usr/bin/env node
'use strict';
/**
 * build.js — turns the readable source into a deployable `dist/` folder.
 *
 *   npm run build            (needs `npm install` once, for esbuild)
 *
 * What it does
 *   • minifies app.js, every chunks/*.js and the CSS (esbuild, ES2017 target);
 *   • puts a content hash in every file name (app.3f9a1c07be.js), so a file
 *     can be cached "forever" and a changed file always gets a new URL;
 *   • rewrites the HTML and CSS to point at those names, and writes the chunk
 *     file names into the app's <script data-chunks="…"> attribute (app.js
 *     reads it to know what to fetch on demand);
 *   • copies only what the site needs — assets/source/ (the full-size masters),
 *     tests, docs and tooling stay out of dist/;
 *   • checks that every local file the pages and the CSS refer to exists.
 *
 * Without a build the site still works exactly the same: `node serve.js`
 * serves the source files, and app.js falls back to chunks/<name>.js.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

let esbuild;
try { esbuild = require('esbuild'); }
catch (_) {
  console.error('build.js needs esbuild. Run `npm install` first.');
  process.exit(1);
}

const ROOT = __dirname;
const OUT = path.join(ROOT, 'dist');

const PAGES = ['index.html', 'privacy.html', 'terms.html', 'cookies.html', '404.html'];
const STYLES = ['style.css', 'legal.css'];
const SCRIPTS = ['app.js', 'legal.js'];
const BANNER = '/*! Bat-Viewer - MIT License - see LICENSE */';

const written = [];                 // { file, bytes } for the size report
const renames = new Map();          // 'assets/logo-96.png' -> 'assets/logo-96.1a2b3c4d5e.png'

function hash(buf) { return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10); }
function read(p) { return fs.readFileSync(path.join(ROOT, p)); }
function write(file, data) {
  const abs = path.join(OUT, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
  written.push({ file, bytes: Buffer.byteLength(data) });
}
function hashedName(file, buf) {
  const ext = path.extname(file);
  return file.slice(0, file.length - ext.length) + '.' + hash(buf) + ext;
}
function fail(msg) { console.error('build failed: ' + msg); process.exit(1); }

/* Replace every occurrence of each key with its value (longest key first, so
   'assets/logo-96.png' can never be hit by a shorter prefix). */
function applyRenames(text, map) {
  const keys = Array.from(map.keys()).sort((a, b) => b.length - a.length);
  keys.forEach((k) => { text = text.split(k).join(map.get(k)); });
  return text;
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

/* 1 ── static assets (images). Only files directly in assets/: the masters live in assets/source/. */
fs.readdirSync(path.join(ROOT, 'assets'), { withFileTypes: true })
  .filter((d) => d.isFile())
  .forEach((d) => {
    const src = 'assets/' + d.name;
    const buf = read(src);
    const out = hashedName(src, buf);
    renames.set(src, out);
    write(out, buf);
  });

/* 2 ── CSS (minified; asset URLs point at the hashed images) */
STYLES.forEach((file) => {
  if (!fs.existsSync(path.join(ROOT, file))) return;
  const raw = applyRenames(read(file).toString('utf8'), renames);
  const min = esbuild.transformSync(raw, { loader: 'css', minify: true, legalComments: 'none' }).code;
  const out = hashedName(file, Buffer.from(min));
  renames.set(file, out);
  write(out, min);
});

/* 3 ── JavaScript: the core, the lazy chunks and the legal-page helper */
const chunkManifest = {};
function minifyJs(code) {
  return esbuild.transformSync(code, { minify: true, target: 'es2017', legalComments: 'none', banner: BANNER }).code;
}
SCRIPTS.forEach((file) => {
  if (!fs.existsSync(path.join(ROOT, file))) return;
  const min = minifyJs(read(file).toString('utf8'));
  const out = hashedName(file, Buffer.from(min));
  renames.set(file, out);
  write(out, min);
});
fs.readdirSync(path.join(ROOT, 'chunks')).filter((f) => f.endsWith('.js')).sort().forEach((f) => {
  const src = fs.readFileSync(path.join(ROOT, 'chunks', f), 'utf8');
  const name = f.replace(/\.js$/, '');
  const m = /BVChunk\(\s*'([^']+)'/.exec(src);
  if (!m || m[1] !== name) fail('chunks/' + f + ' must register itself as BVChunk(\'' + name + '\', …)');
  const min = minifyJs(src);
  const out = hashedName('chunks/' + f, Buffer.from(min));
  chunkManifest[name] = out;
  write(out, min);
});

/* 4 ── HTML pages */
PAGES.forEach((file) => {
  if (!fs.existsSync(path.join(ROOT, file))) return;
  let html = read(file).toString('utf8');
  html = html.replace(/<!--[\s\S]*?-->\n?/g, '').replace(/\n[ \t]*\n+/g, '\n');   // comments and blank lines are for people reading the source
  html = applyRenames(html, renames);
  if (/id="bvScript"/.test(html)) {
    html = html.replace('id="bvScript"', 'id="bvScript" data-chunks=\'' + JSON.stringify(chunkManifest) + '\'');
  }
  write(file, html);
});

/* 5 ── other files the site serves as they are */
['LICENSE'].forEach((f) => { if (fs.existsSync(path.join(ROOT, f))) write(f, read(f)); });
write('.nojekyll', '');                                          // GitHub Pages: serve files as-is

/* 6 ── every local reference must resolve to a file in dist/ */
function checkRefs(file, text, patterns) {
  const base = path.posix.dirname(file);
  patterns.forEach((re) => {
    let m;
    while ((m = re.exec(text))) {
      const ref = m[1];
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|data:)/i.test(ref)) continue;       // external, mailto:, anchors, data:
      const clean = ref.split('#')[0].split('?')[0];
      if (!clean) continue;
      const target = path.posix.normalize(path.posix.join(base === '.' ? '' : base, clean));
      if (!fs.existsSync(path.join(OUT, target))) fail(file + ' refers to "' + ref + '" which is not in dist/');
    }
  });
}
PAGES.concat(Object.values(renames).filter((f) => f.endsWith('.css'))).forEach((file) => {
  const abs = path.join(OUT, file);
  if (!fs.existsSync(abs)) return;
  const text = fs.readFileSync(abs, 'utf8');
  if (file.endsWith('.html')) checkRefs(file, text, [/(?:href|src)="([^"]+)"/g]);
  else checkRefs(file, text, [/url\(\s*["']?([^"')]+)["']?\s*\)/g]);
});
Object.values(chunkManifest).forEach((f) => { if (!fs.existsSync(path.join(OUT, f))) fail('missing chunk ' + f); });
['app.js'].forEach((f) => { if (!renames.has(f)) fail('app.js was not built'); });

/* 7 ── report */
function size(n) { return (n / 1024).toFixed(1).padStart(7) + ' KB'; }
console.log('\nBuilt dist/  (' + written.length + ' files)\n');
console.log('  file'.padEnd(46) + '     raw   brotli');
written.filter((w) => w.bytes > 0).sort((a, b) => a.file.localeCompare(b.file)).forEach((w) => {
  let br = '';
  if (/\.(?:html|js|css)$/.test(w.file)) {
    br = size(zlib.brotliCompressSync(fs.readFileSync(path.join(OUT, w.file))).length);
  }
  console.log(('  ' + w.file).padEnd(46) + size(w.bytes) + br);
});
const critical = [renames.get('app.js'), renames.get('style.css'), 'index.html'];
const crit = critical.reduce((n, f) => n + zlib.brotliCompressSync(fs.readFileSync(path.join(OUT, f))).length, 0);
console.log('\n  critical path (html + css + app.js, brotli): ' + size(crit).trim());
