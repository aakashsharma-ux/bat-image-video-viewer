'use strict';
/* build.js: runs the real build, checks what lands in dist/, and then runs the
   built (minified, hashed) files in jsdom to make sure they still work. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

let pass = 0, fail = 0;
function assert(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra !== undefined ? '   -> ' + JSON.stringify(extra) : '')); }
}
function section(name) { console.log('\n' + name); }
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 10));

function walk(dir, base) {
  base = base || dir;
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((acc, e) => {
    const abs = path.join(dir, e.name);
    return e.isDirectory() ? acc.concat(walk(abs, base)) : acc.concat(path.relative(base, abs).split(path.sep).join('/'));
  }, []);
}
function build() {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'build.js')], { cwd: ROOT, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

(async () => {
  try {
    section('BUILD: runs cleanly');
    const first = build();
    assert(first.code === 0, 'build.js exits 0', first.out.slice(-400));
    const files1 = walk(DIST).sort();

    section('BUILD: output is deterministic');
    const second = build();
    const files2 = walk(DIST).sort();
    assert(second.code === 0 && JSON.stringify(files1) === JSON.stringify(files2), 'building twice gives identical file names (hashes depend on content only)');

    section('BUILD: what is (and is not) deployed');
    const has = (re) => files1.some((f) => re.test(f));
    assert(has(/^index\.html$/) && has(/^privacy\.html$/) && has(/^terms\.html$/) && has(/^cookies\.html$/) && has(/^404\.html$/), 'all five pages are there');
    assert(has(/^app\.[0-9a-f]{10}\.js$/) && has(/^style\.[0-9a-f]{10}\.css$/), 'app and stylesheet carry a content hash');
    assert(has(/^assets\/bg-1280\.[0-9a-f]{10}\.avif$/) && has(/^assets\/bg-1920\.[0-9a-f]{10}\.webp$/) && has(/^assets\/logo-96\.[0-9a-f]{10}\.png$/), 'images carry a content hash');
    assert(files1.indexOf('.nojekyll') > -1 && files1.indexOf('LICENSE') > -1, '.nojekyll and LICENSE are included');
    assert(!files1.some((f) => /^assets\/source\//.test(f) || /\.map$/.test(f) || /^(tests|node_modules|docs)\//.test(f) || /^(build|serve)\.js$|package|README|ASSETS|\.md$/.test(f)), 'masters, source maps, tests, tooling and docs stay out of dist/', files1);
    const total = files1.reduce((n, f) => n + fs.statSync(path.join(DIST, f)).size, 0);
    assert(total < 1100 * 1024, 'whole site is about 1 MB or less (was 2.2 MB of images alone)', Math.round(total / 1024) + ' KB');

    section('BUILD: index.html');
    const indexHtml = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
    const doc = new JSDOM(indexHtml).window.document;
    const script = doc.getElementById('bvScript');
    assert(script && /^app\.[0-9a-f]{10}\.js$/.test(script.getAttribute('src')) && script.hasAttribute('defer'), 'app script is the hashed file and is deferred');
    let manifest = {};
    try { manifest = JSON.parse(script.getAttribute('data-chunks')); } catch (_) { /* reported below */ }
    const chunkNames = fs.readdirSync(path.join(ROOT, 'chunks')).filter((f) => /\.js$/.test(f)).map((f) => f.replace(/\.js$/, '')).sort();
    assert(JSON.stringify(Object.keys(manifest).sort()) === JSON.stringify(chunkNames), 'data-chunks lists every chunk', manifest);
    assert(Object.keys(manifest).every((k) => new RegExp('^chunks/' + k + '\\.[0-9a-f]{10}\\.js$').test(manifest[k]) && fs.existsSync(path.join(DIST, manifest[k]))), 'and every listed file exists');
    const sheet = doc.querySelector('link[rel=stylesheet]');
    assert(sheet && /^style\.[0-9a-f]{10}\.css$/.test(sheet.getAttribute('href')), 'stylesheet link points at the hashed file');
    const preloads = Array.from(doc.querySelectorAll('link[rel=preload]')).map((l) => l.getAttribute('href'));
    assert(preloads.length === 2 && preloads.every((h) => fs.existsSync(path.join(DIST, h))), 'wallpaper preloads point at existing hashed files', preloads);
    assert(/script-src 'self'/.test(indexHtml) && !/<!--/.test(indexHtml), 'the security policy survives; source comments are removed');
    const css = fs.readFileSync(path.join(DIST, sheet.getAttribute('href')), 'utf8');
    const cssRefs = (css.match(/url\(["']?[^"')]+/g) || []).map((u) => u.replace(/^url\(["']?/, ''));
    assert(cssRefs.length >= 4 && cssRefs.every((u) => fs.existsSync(path.join(DIST, u))), 'every url() in the stylesheet resolves to a hashed file', cssRefs);
    assert(files1.filter((f) => /^(?:.+)\.html$/.test(f)).every((f) => {
      const d = new JSDOM(fs.readFileSync(path.join(DIST, f), 'utf8')).window.document;
      return Array.from(d.querySelectorAll('[href], [src]')).every((n) => {
        const u = n.getAttribute('href') || n.getAttribute('src');
        if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(u)) return true;
        const clean = u.split('#')[0];
        return clean === '' || clean === './' || fs.existsSync(path.join(DIST, clean));
      });
    }), 'no page links to a file that is missing from dist/');

    section('BUILD: size budget');
    const br = (f) => zlib.brotliCompressSync(fs.readFileSync(path.join(DIST, f))).length;
    const appFile = script.getAttribute('src'), cssFile = sheet.getAttribute('href');
    const critical = br('index.html') + br(appFile) + br(cssFile);
    assert(critical < 30 * 1024, 'HTML + CSS + app.js come to under 30 KB with brotli (was 108 KB of unminified JS alone)', (critical / 1024).toFixed(1) + ' KB');
    assert(fs.statSync(path.join(DIST, appFile)).size < 60 * 1024, 'minified app.js is under 60 KB (source is 108 KB)', fs.statSync(path.join(DIST, appFile)).size);
    const marker = { 'video-card': 'Capture frame as image', 'edit-mode': 'epBrightness', 'common-notes': 'cnTextarea', 'retry-failed': 'Retrying...' };
    const core = fs.readFileSync(path.join(DIST, appFile), 'utf8');
    assert(Object.keys(marker).every((k) => fs.readFileSync(path.join(DIST, manifest[k]), 'utf8').includes(marker[k]) && !core.includes(marker[k])),
      'each chunk holds its own code, and none of it is inside the core bundle');
    files1.filter((f) => /\.js$/.test(f)).forEach((f) => {
      let ok = true;
      try { new vm.Script(fs.readFileSync(path.join(DIST, f), 'utf8'), { filename: f }); } catch (e) { ok = e.message; }
      assert(ok === true, f + ' is valid JavaScript', ok);
    });

    section('BUILT SITE: runs in jsdom (hashed chunk loading, core flows)');
    const builtHtml = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
    const dom = new JSDOM(builtHtml, { url: 'https://viewer.example/', pretendToBeVisual: true, runScripts: 'outside-only' });
    const w = dom.window, d = w.document;
    class FakeIO {
      constructor(cb) { this.cb = cb; }
      observe(el) { this.cb([{ target: el, isIntersecting: true }]); }
      unobserve() {} disconnect() {}
    }
    w.IntersectionObserver = FakeIO;
    const mp = w.HTMLMediaElement.prototype;
    mp.pause = function () {}; mp.load = function () {}; mp.play = function () { return Promise.resolve(); };
    w.scrollBy = function () {};    /* jsdom has no layout; the Edit bar's scroll-into-view would only print "not implemented" */
    const inserted = [];
    const head = d.head, orig = head.appendChild.bind(head);
    head.appendChild = function (node) { if (node && node.tagName === 'SCRIPT' && node.src) { inserted.push(node); return node; } return orig(node); };
    w.eval(fs.readFileSync(path.join(DIST, appFile), 'utf8'));
    d.getElementById('bulkArea').value = ['https://cdn.example/a.jpg', 'https://cdn.example/b.png', 'https://cdn.example/c.mp4'].join('\n');
    d.getElementById('bulkLoadBtn').click();
    for (let i = 0; i < 100 && d.getElementById('bulkLoadBtn').disabled; i++) await tick(20);
    await tick(30);
    assert(d.querySelectorAll('#gallery .vslot').length === 3 && d.querySelectorAll('img.card-img').length === 2, 'minified core builds the gallery');
    assert(inserted.length === 1 && inserted[0].getAttribute('src') === manifest['video-card'], 'the video chunk is requested under its hashed name', inserted.map((s) => s.getAttribute('src')));
    w.eval(fs.readFileSync(path.join(DIST, manifest['video-card']), 'utf8'));
    inserted[0].onload();
    await tick(30);
    assert(d.querySelectorAll('video.card-video').length === 1 && d.querySelectorAll('.card-pending').length === 0, 'once the minified chunk arrives, the video player replaces the placeholder');
    d.querySelector('.tedit').click();
    assert(inserted.length === 2 && inserted[1].getAttribute('src') === manifest['edit-mode'], 'the Edit button requests its hashed chunk');
    w.eval(fs.readFileSync(path.join(DIST, manifest['edit-mode']), 'utf8'));
    inserted[1].onload();
    await tick(30);
    assert(!!d.getElementById('editPanel') && d.getElementById('editPanel').classList.contains('visible'), 'and the minified Edit panel opens');
    w.close();
  } catch (e) {
    console.error('\nTEST CRASHED:', e);
    fail++;
  }
  console.log('\n' + '='.repeat(50));
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
