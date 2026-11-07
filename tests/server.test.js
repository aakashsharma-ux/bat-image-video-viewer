'use strict';
/* serve.js: caching, compression, security headers and path safety.
   Starts the real server on a random port, serving a throw-away folder. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
function assert(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra !== undefined ? '   -> ' + JSON.stringify(extra) : '')); }
}
function section(name) { console.log('\n' + name); }

/* ── fixture folder ──
   tmp/
     site/            <- served
       index.html  privacy.html  404.html  plain.js  app.0123456789.js  style.css  pic.png
       .secret  node_modules/x.js  sub/ (empty)  link -> ../site-secret
     site-secret/secret.txt   (shares the "site" name prefix on purpose) */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bv-serve-'));
const site = path.join(tmp, 'site'), outside = path.join(tmp, 'site-secret');
fs.mkdirSync(path.join(site, 'node_modules'), { recursive: true });
fs.mkdirSync(path.join(site, 'sub'));
fs.mkdirSync(outside);
const bigCss = 'body { margin: 0; padding: 0; color: #fff; }\n'.repeat(60);
fs.writeFileSync(path.join(site, 'index.html'), '<!doctype html><title>home</title>' + '<p>hello</p>'.repeat(80));
fs.writeFileSync(path.join(site, 'privacy.html'), '<!doctype html><title>privacy</title><p>policy</p>');
fs.writeFileSync(path.join(site, '404.html'), '<!doctype html><title>nope</title><p>Page not found</p>');
fs.writeFileSync(path.join(site, 'plain.js'), 'console.log(1);\n'.repeat(80));
fs.writeFileSync(path.join(site, 'app.0123456789.js'), 'console.log(2);\n'.repeat(80));
fs.writeFileSync(path.join(site, 'style.css'), bigCss);
fs.writeFileSync(path.join(site, 'tiny.css'), 'a{b:c}');
fs.writeFileSync(path.join(site, 'pic.png'), require('crypto').randomBytes(4000));
fs.writeFileSync(path.join(site, '.secret'), 'dotfile');
fs.writeFileSync(path.join(site, 'node_modules', 'x.js'), 'module');
fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET');
let symlinkOk = true;
try { fs.symlinkSync(outside, path.join(site, 'link'), 'dir'); } catch (_) { symlinkOk = false; }

function request(port, method, p, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: headers || {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

function start() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'serve.js'), site, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      const m = /:(\d+)\s*$/m.exec(out);
      if (m) resolve({ child, port: Number(m[1]) });
    });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => reject(new Error('server exited early (' + code + '): ' + out)));
    setTimeout(() => reject(new Error('server did not start: ' + out)), 8000);
  });
}

(async () => {
  const { child, port } = await start();
  const get = (p, h) => request(port, 'GET', p, h);
  try {
    section('PAGES: headers');
    let r = await get('/');
    assert(r.status === 200 && /^text\/html/.test(r.headers['content-type']), 'GET / serves index.html');
    assert(r.headers['x-content-type-options'] === 'nosniff', 'X-Content-Type-Options: nosniff');
    assert(/strict-origin-when-cross-origin/.test(r.headers['referrer-policy']), 'Referrer-Policy');
    assert(/frame-ancestors 'none'/.test(r.headers['content-security-policy']) && r.headers['x-frame-options'] === 'DENY', 'pages cannot be framed');
    assert(/camera=\(\)/.test(r.headers['permissions-policy']), 'Permissions-Policy turns sensors off');
    assert(r.headers['cache-control'] === 'no-cache', 'unhashed files are revalidated, not cached blindly', r.headers['cache-control']);
    assert(/^"[0-9a-f]{20}"$/.test(r.headers.etag), 'ETag is a content hash', r.headers.etag);
    r = await get('/privacy');
    assert(r.status === 200 && /privacy/.test(r.body.toString()), '/privacy finds privacy.html');

    section('CACHING');
    r = await get('/app.0123456789.js');
    assert(r.headers['cache-control'] === 'public, max-age=31536000, immutable', 'content-hashed file is immutable for a year', r.headers['cache-control']);
    r = await get('/plain.js');
    const tag = r.headers.etag;
    let r2 = await get('/plain.js', { 'If-None-Match': tag });
    assert(r2.status === 304 && r2.body.length === 0, 'matching If-None-Match gets a 304 with no body');
    assert(r2.headers.etag === tag, '304 repeats the ETag');
    r2 = await get('/plain.js', { 'If-None-Match': '"something-else"' });
    assert(r2.status === 200 && r2.body.length > 0, 'a different ETag gets the full file');
    r2 = await get('/plain.js', { 'If-None-Match': 'W/' + tag + ', "x"' });
    assert(r2.status === 304, 'weak validators and lists are understood');

    section('COMPRESSION');
    const plain = fs.readFileSync(path.join(site, 'style.css'));
    r = await get('/style.css', { 'Accept-Encoding': 'gzip, deflate, br' });
    assert(r.headers['content-encoding'] === 'br' && /Accept-Encoding/i.test(r.headers.vary), 'brotli is preferred when accepted, with Vary');
    assert(zlib.brotliDecompressSync(r.body).equals(plain) && r.body.length < plain.length / 3, 'brotli body round-trips and is much smaller', [r.body.length, plain.length]);
    assert(Number(r.headers['content-length']) === r.body.length, 'Content-Length matches the compressed body');
    const brTag = r.headers.etag;
    r = await get('/style.css', { 'Accept-Encoding': 'gzip' });
    assert(r.headers['content-encoding'] === 'gzip' && zlib.gunzipSync(r.body).equals(plain), 'gzip when that is all the browser takes');
    assert(r.headers.etag !== brTag, 'each encoding has its own ETag');
    r2 = await get('/style.css', { 'Accept-Encoding': 'gzip', 'If-None-Match': r.headers.etag });
    assert(r2.status === 304, 'a compressed ETag revalidates to 304');
    r = await get('/style.css', { 'Accept-Encoding': 'br;q=0, gzip;q=0.5' });
    assert(r.headers['content-encoding'] === 'gzip', 'q-values are honoured');
    r = await get('/style.css');
    assert(!r.headers['content-encoding'] && r.body.equals(plain), 'no Accept-Encoding: sent as it is');
    r = await get('/pic.png', { 'Accept-Encoding': 'br, gzip' });
    assert(!r.headers['content-encoding'] && r.headers['content-type'] === 'image/png', 'images are not recompressed');
    r = await get('/tiny.css', { 'Accept-Encoding': 'br, gzip' });
    assert(!r.headers['content-encoding'], 'tiny files are not compressed (nothing to gain)');

    section('METHODS');
    r = await request(port, 'HEAD', '/style.css', { 'Accept-Encoding': 'gzip' });
    assert(r.status === 200 && r.body.length === 0 && Number(r.headers['content-length']) > 0, 'HEAD returns headers only, with a length');
    r = await request(port, 'POST', '/');
    assert(r.status === 405 && /GET/.test(r.headers.allow), 'POST is refused with Allow');
    r = await request(port, 'DELETE', '/index.html');
    assert(r.status === 405, 'DELETE is refused');

    section('NOT FOUND AND BAD INPUT');
    r = await get('/missing.html');
    assert(r.status === 404 && /Page not found/.test(r.body.toString()), '404 serves 404.html with a 404 status');
    r = await get('/sub/');
    assert(r.status === 404, 'a folder without index.html is a 404, not a listing');
    r = await get('/%E0%A4%A');
    assert(r.status === 400, 'a broken percent-escape is a 400');

    section('PATH SAFETY');
    const outsideBody = 'TOP SECRET';
    for (const p of ['/../site-secret/secret.txt', '/%2e%2e/site-secret/secret.txt', '/..%2fsite-secret%2fsecret.txt', '/sub/../../site-secret/secret.txt', '/%2e%2e%2f%2e%2e%2fsite-secret/secret.txt', '/..\\site-secret\\secret.txt', '/%00']) {
      r = await get(p);
      assert(r.status >= 400 && r.body.toString().indexOf(outsideBody) === -1, 'traversal attempt blocked: ' + p, r.status);
    }
    if (symlinkOk) {
      r = await get('/link/secret.txt');
      assert(r.status === 403 && r.body.toString().indexOf(outsideBody) === -1, 'a symlink out of the folder is refused (even to a folder whose name starts the same)', r.status);
    } else {
      console.log('  - symlink check skipped (cannot create symlinks here)');
    }
    r = await get('/.secret');
    assert(r.status === 403 && r.body.toString().indexOf('dotfile') === -1, 'dotfiles are never served');
    r = await get('/node_modules/x.js');
    assert(r.status === 403, 'node_modules is never served');
  } catch (e) {
    console.error('\nTEST CRASHED:', e);
    fail++;
  } finally {
    child.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log('\n' + '='.repeat(50));
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
