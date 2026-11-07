#!/usr/bin/env node
'use strict';
/**
 * serve.js — small static server for Bat-Viewer. No npm packages needed.
 *
 *   node serve.js              serve this folder (works without a build)
 *   node serve.js dist         serve the production build (npm run build)
 *   PORT=8080 node serve.js dist
 *   node serve.js dist --port 8080 --host 0.0.0.0 --quiet
 *
 * Then open http://localhost:3000 (the default).
 *
 * Besides serving files it does what a production host should:
 *   • HTTP caching      — files with a content hash in the name (app.3f9a1c07be.js)
 *                         are cacheable for a year ("immutable"); everything else
 *                         is revalidated with an ETag, so unchanged files cost a
 *                         304 with no body. Put a CDN in front and it will cache
 *                         correctly with no extra configuration.
 *   • Compression       — text files (html/js/css/svg/json) are sent as brotli or
 *                         gzip when the browser accepts it. Images are already
 *                         compressed and are sent as they are.
 *   • Server-side cache — files are kept in memory (bounded, least-recently-used
 *                         eviction) together with their compressed forms, and are
 *                         re-read only when they change on disk.
 *   • Safe defaults     — no path can escape the served folder (including through
 *                         symlinks), dotfiles and node_modules are never served,
 *                         security headers are sent, only GET/HEAD are allowed.
 *
 * Transport security (HTTPS / HSTS) is the job of whatever hosts this — GitHub
 * Pages and every CDN do it for you — so it is deliberately not done here.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { promisify } = require('util');

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

/* ── options ── */
function parseArgs(argv, env) {
  const o = { dir: null, port: env.PORT !== undefined ? Number(env.PORT) : 3000, host: env.HOST || '127.0.0.1', quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') o.port = Number(argv[++i]);
    else if (a === '--host') o.host = argv[++i];
    else if (a === '--quiet' || a === '-q') o.quiet = true;
    else if (a[0] !== '-' && o.dir === null) o.dir = a;
    else { console.error('Unknown option: ' + a + '\nUsage: node serve.js [folder] [--port N] [--host H] [--quiet]'); process.exit(2); }
  }
  if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) { console.error('Invalid port.'); process.exit(2); }
  return o;
}

const opts = parseArgs(process.argv.slice(2), process.env);
const ROOT = fs.realpathSync(path.resolve(opts.dir || __dirname));

/* ── content types ── */
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8',
  '.md':   'text/plain; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico':  'image/x-icon',
  '.woff2': 'font/woff2'
};
function isCompressible(type) {
  return /^text\//.test(type) || /json|javascript|xml|svg/.test(type);
}

/* A hash segment in the file name (app.3f9a1c07be.js) means the content can never change under that name. */
const HASHED = /\.[0-9a-f]{8,}\.[a-z0-9]+$/;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin'
};
/* frame-ancestors cannot be set from a <meta> tag, so it goes out as a header on pages. */
const PAGE_HEADERS = {
  'Content-Security-Policy': "frame-ancestors 'none'",
  'X-Frame-Options': 'DENY'
};

/* ── in-memory file cache ── */
const CACHE_MAX_BYTES = 64 * 1024 * 1024;     // total
const CACHE_MAX_FILE = 4 * 1024 * 1024;       // larger files are streamed, not cached
const MIN_COMPRESS = 512;                     // below this, compression saves nothing
const cache = new Map();                      // absolute path -> entry (Map order = least recently used first)
let cacheBytes = 0;

function touch(abs, entry) { cache.delete(abs); cache.set(abs, entry); }
function remember(abs, entry) {
  const old = cache.get(abs);
  if (old) cacheBytes -= old.bytes;
  cache.delete(abs);
  cache.set(abs, entry);
  cacheBytes += entry.bytes;
  for (const [key, e] of cache) {
    if (cacheBytes <= CACHE_MAX_BYTES) break;
    if (key === abs) continue;
    cache.delete(key);
    cacheBytes -= e.bytes;
  }
}

async function loadEntry(abs, st) {
  const hit = cache.get(abs);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) { touch(abs, hit); return hit; }
  const ext = path.extname(abs).toLowerCase();
  const type = TYPES[ext] || 'application/octet-stream';
  if (st.size > CACHE_MAX_FILE) {
    return { abs, type, size: st.size, mtimeMs: st.mtimeMs, body: null, etag: '"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"',
             variants: Object.create(null), bytes: 0, compressible: false };
  }
  const body = await fs.promises.readFile(abs);
  const entry = {
    abs, type, size: st.size, mtimeMs: st.mtimeMs, body,
    etag: '"' + crypto.createHash('sha1').update(body).digest('hex').slice(0, 20) + '"',
    variants: Object.create(null),               // 'br' | 'gzip' -> Promise<Buffer|null>
    bytes: body.length,
    compressible: isCompressible(type) && body.length >= MIN_COMPRESS
  };
  remember(abs, entry);
  return entry;
}

/* The compressed form is made once per file version and kept with the entry. */
function variant(entry, enc) {
  if (!entry.variants[enc]) {
    const run = enc === 'br'
      ? brotli(entry.body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: entry.body.length } })
      : gzip(entry.body, { level: 6 });
    entry.variants[enc] = run.then((buf) => {
      if (buf.length >= entry.body.length) return null;          // not worth it
      if (cache.get(entry.abs) === entry) { cacheBytes += buf.length; entry.bytes += buf.length; }   // still cached
      return buf;
    }, () => null);
  }
  return entry.variants[enc];
}

function pickEncoding(header) {
  if (!header) return null;
  const accepted = {};
  String(header).split(',').forEach((part) => {
    const m = /^\s*([a-z*-]+)\s*(?:;\s*q=([0-9.]+))?\s*$/i.exec(part);
    if (m) accepted[m[1].toLowerCase()] = m[2] === undefined ? 1 : Number(m[2]);
  });
  if (accepted.br > 0) return 'br';
  if (accepted.gzip > 0 || accepted['x-gzip'] > 0) return 'gzip';
  return null;
}

function etagMatches(header, etag) {
  if (!header) return false;
  if (header.trim() === '*') return true;
  const bare = etag.replace(/^W\//, '');
  return header.split(',').some((t) => t.trim().replace(/^W\//, '') === bare);
}

/* ── mapping a URL to a file inside ROOT ── */
async function resolveFile(urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath); } catch (_) { return { status: 400 }; }
  if (p.indexOf('\0') !== -1 || p.indexOf('\\') !== -1) return { status: 400 };
  const segs = p.split('/').filter(Boolean);
  for (const s of segs) {
    if (s === '..' || s[0] === '.' || s === 'node_modules') return { status: 403 };
  }
  const tryPaths = [];
  const joined = path.join(ROOT, ...segs);
  const wantsDir = p.endsWith('/') || segs.length === 0;
  if (wantsDir) tryPaths.push(path.join(joined, 'index.html'));
  else { tryPaths.push(joined); if (!path.extname(joined)) tryPaths.push(joined + '.html'); }   // /privacy -> privacy.html
  for (const candidate of tryPaths) {
    let real;
    try { real = await fs.promises.realpath(candidate); } catch (_) { continue; }
    if (real !== ROOT && real.indexOf(ROOT + path.sep) !== 0) return { status: 403 };   // a symlink leading out
    let st;
    try { st = await fs.promises.stat(real); } catch (_) { continue; }
    if (st.isFile()) return { abs: real, st };
  }
  return { status: 404 };
}

/* ── responses ── */
function send(res, status, headers, body, head) {
  const h = Object.assign({}, SECURITY_HEADERS, headers);
  if (body !== null && body !== undefined && h['Content-Length'] === undefined) h['Content-Length'] = Buffer.byteLength(body);
  res.writeHead(status, h);
  res.end(head ? undefined : body);
}

async function notFound(res, head) {
  const page = await resolveFile('/404.html');
  if (page.abs) {
    const entry = await loadEntry(page.abs, page.st);
    return send(res, 404, Object.assign({ 'Content-Type': entry.type, 'Cache-Control': 'no-cache' }, PAGE_HEADERS), entry.body, head);
  }
  send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' }, 'Not found', head);
}

async function handle(req, res) {
  const head = req.method === 'HEAD';
  if (req.method !== 'GET' && !head) {
    return send(res, 405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' }, 'Method not allowed', false);
  }
  const rawPath = (req.url || '/').split('?')[0].split('#')[0];
  const found = await resolveFile(rawPath);
  if (!found.abs) {
    if (found.status === 404) return notFound(res, head);
    return send(res, found.status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
                found.status === 403 ? 'Forbidden' : 'Bad request', head);
  }

  const entry = await loadEntry(found.abs, found.st);
  const isPage = entry.type.indexOf('text/html') === 0;
  const headers = { 'Content-Type': entry.type };
  headers['Cache-Control'] = HASHED.test(path.basename(found.abs)) ? 'public, max-age=31536000, immutable' : 'no-cache';
  if (isPage) Object.assign(headers, PAGE_HEADERS);

  let body = entry.body;
  let etag = entry.etag;
  let encoding = null;
  if (entry.compressible) {
    headers.Vary = 'Accept-Encoding';
    const want = pickEncoding(req.headers['accept-encoding']);
    if (want) {
      const packed = await variant(entry, want);
      if (packed) { body = packed; encoding = want; etag = entry.etag.slice(0, -1) + '-' + (want === 'br' ? 'br' : 'gz') + '"'; }
    }
  }
  headers.ETag = etag;
  if (encoding) headers['Content-Encoding'] = encoding;

  if (etagMatches(req.headers['if-none-match'], etag)) {
    delete headers['Content-Type'];
    return send(res, 304, headers, null, true);
  }

  if (body === null) {                           // large file: stream it
    headers['Content-Length'] = entry.size;
    res.writeHead(200, Object.assign({}, SECURITY_HEADERS, headers));
    if (head) return res.end();
    const stream = fs.createReadStream(entry.abs);
    stream.on('error', () => res.destroy());
    return stream.pipe(res);
  }
  headers['Content-Length'] = body.length;
  send(res, 200, headers, body, head);
}

const server = http.createServer((req, res) => {
  const started = Date.now();
  if (!opts.quiet) {
    res.on('finish', () => {
      const enc = res.getHeader('content-encoding');
      console.log(req.method + ' ' + req.url + ' ' + res.statusCode + ' ' + (Date.now() - started) + 'ms' + (enc ? ' (' + enc + ')' : ''));
    });
  }
  handle(req, res).catch((err) => {
    if (!opts.quiet) console.error(err);
    if (!res.headersSent) send(res, 500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, 'Server error', false);
    else res.destroy();
  });
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 5000;

server.listen(opts.port, opts.host, () => {
  const addr = server.address();
  const shown = addr.address === '0.0.0.0' || addr.address === '::' ? 'localhost' : addr.address;
  console.log('Bat-Viewer serving ' + (path.relative(process.cwd(), ROOT) || '.') + ' at http://' + (shown === '127.0.0.1' ? 'localhost' : shown) + ':' + addr.port);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
