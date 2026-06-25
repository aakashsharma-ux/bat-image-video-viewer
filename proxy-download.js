/**
 * proxy-download.js — BAT-Viewer backend route
 * ──────────────────────────────────────────────
 * Handles:  GET /api/proxy-download?url=<encoded-image-url>
 *
 * Purpose
 * ───────
 * Many image hosts (NYT, Reddit, paywalled CDNs) block browser-side
 * cross-origin fetches at the CDN level (no CORS headers, or active
 * IP-blocking of known proxy services).  Fetching from Node.js bypasses
 * all of that: the request looks like a normal browser page-load because
 * it is one — it comes from your server's IP and carries realistic
 * browser headers.
 *
 * How to wire it up
 * ─────────────────
 * In your existing HTTP request handler, add ONE check before the rest
 * of your routing:
 *
 *   var proxyDownload = require('./proxy-download');
 *
 *   // inside your requestListener(req, res) function:
 *   var pathname = require('url').parse(req.url).pathname;
 *   if (pathname === '/api/proxy-download') {
 *     return proxyDownload(req, res);
 *   }
 *
 * No npm packages required — uses only Node.js built-ins.
 */

'use strict';

var https = require('https');
var http  = require('http');
var urlMod = require('url');

/* ── Security: hosts that must never be proxied ──────────────────────
   Add any internal-only hostname your server has access to so that
   the proxy cannot be weaponised to reach private infrastructure.     */
var BLOCKED_HOSTS = [
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
];

function isBlockedHost(hostname) {
  if (!hostname) return true;
  var h = hostname.toLowerCase();
  for (var i = 0; i < BLOCKED_HOSTS.length; i++) {
    if (h === BLOCKED_HOSTS[i]) return true;
  }
  /* Block RFC-1918 ranges expressed as hostnames (rare but possible) */
  if (/^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(h)) return true;
  return false;
}

/**
 * proxyDownload(req, res)
 *
 * Fetches the image at ?url= server-side and streams it back to the
 * browser with Content-Disposition: attachment so it triggers a file
 * save rather than a navigation.
 */
function proxyDownload(req, res) {
  /* Allow preflight if the frontend is on a different port during dev */
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin'          : '*',
      'Access-Control-Allow-Methods'         : 'GET, OPTIONS',
      'Access-Control-Allow-Private-Network' : 'true',
      'Access-Control-Max-Age'               : '86400',
    });
    return res.end();
  }

  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    return res.end('Method Not Allowed');
  }

  /* ── Parse and validate the target URL ────────────────────────── */
  var query     = urlMod.parse(req.url, true).query;
  var targetUrl = query.url;

  if (!targetUrl || typeof targetUrl !== 'string') {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('Bad Request: missing ?url= parameter');
  }

  if (!/^https?:\/\//i.test(targetUrl)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('Bad Request: url must start with http:// or https://');
  }

  var target;
  try {
    target = urlMod.parse(targetUrl);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('Bad Request: could not parse url');
  }

  if (isBlockedHost(target.hostname)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden: target host is not allowed');
  }

  /* ── Derive a download filename from the URL path ──────────────── */
  var rawName  = (target.pathname || '').split('/').pop() || 'image';
  var filename = rawName.split(/[?#]/)[0] || 'image';
  if (!/\.[a-z]{2,5}$/i.test(filename)) filename += '.jpg';

  /* ── Make the upstream request ─────────────────────────────────── */
  var useHttps = target.protocol === 'https:';
  var lib      = useHttps ? https : http;

  var options = {
    hostname: target.hostname,
    port    : target.port ? parseInt(target.port, 10) : (useHttps ? 443 : 80),
    path    : target.path || '/',
    method  : 'GET',
    headers : {
      /* Present as a real Chrome browser so CDNs accept the request */
      'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept'         : 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'identity',           /* avoid compressed blob handling */
      'Referer'        : target.protocol + '//' + target.hostname + '/',
      'Cache-Control'  : 'no-cache',
      'Pragma'         : 'no-cache',
    },
  };

  var upstreamReq = lib.request(options, function (upstreamRes) {
    var status = upstreamRes.statusCode;

    /* Follow a single redirect (301 / 302 / 307 / 308) */
    if ((status === 301 || status === 302 || status === 307 || status === 308)
        && upstreamRes.headers.location
        && !options._redirected) {
      var location = upstreamRes.headers.location;
      /* Consume the body so the socket can be reused */
      upstreamRes.resume();
      /* Resolve relative redirects */
      if (!/^https?:\/\//i.test(location)) {
        location = target.protocol + '//' + target.hostname + location;
      }
      /* Re-run with the redirect target, mark to prevent infinite loops */
      var fakeReq = { method: 'GET', url: req.url.replace(/url=[^&]*/, 'url=' + encodeURIComponent(location)), _redirected: true };
      Object.defineProperty(fakeReq, '_redirected', { value: true });
      options._redirected = true;
      /* Simpler: just recurse once with a patched URL */
      var patchedReq = { method: 'GET', url: '/api/proxy-download?url=' + encodeURIComponent(location) };
      return proxyDownload(patchedReq, res);
    }

    if (status < 200 || status >= 300) {
      upstreamRes.resume();
      if (!res.headersSent) {
        res.writeHead(status, { 'Content-Type': 'text/plain' });
        res.end('Upstream returned HTTP ' + status);
      }
      return;
    }

    var contentType = upstreamRes.headers['content-type'] || 'image/jpeg';

    res.writeHead(200, {
      'Content-Type'               : contentType,
      'Content-Disposition'        : 'attachment; filename="' + filename + '"',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control'              : 'no-store',
      /* Forward Content-Length if present so the browser can show progress */
      'Content-Length'             : upstreamRes.headers['content-length'] || '',
    });

    upstreamRes.pipe(res);

    upstreamRes.on('error', function (err) {
      console.error('[proxy-download] upstream stream error:', err.message);
      if (!res.headersSent) { res.writeHead(502); }
      res.end();
    });
  });

  /* 20-second hard deadline on the upstream request */
  upstreamReq.setTimeout(20000, function () {
    upstreamReq.destroy();
    if (!res.headersSent) {
      res.writeHead(504, { 'Content-Type': 'text/plain' });
      res.end('Gateway Timeout: upstream did not respond in time');
    }
  });

  upstreamReq.on('error', function (err) {
    console.error('[proxy-download] request error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Bad Gateway: ' + err.message);
    }
  });

  upstreamReq.end();
}

module.exports = proxyDownload;
