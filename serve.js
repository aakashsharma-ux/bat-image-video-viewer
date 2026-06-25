/**
 * serve.js — local dev server for BAT-Viewer
 * Run: node serve.js
 * Then open: http://localhost:3000
 *
 * Serves static files from the same folder.
 * No npm packages needed.
 */

'use strict';

var http = require('http');
var fs   = require('fs');
var path = require('path');
var url  = require('url');

var PORT = 3000;
var ROOT = __dirname;

var MIME = {
  '.html': 'text/html',
  '.js'  : 'application/javascript',
  '.css' : 'text/css',
  '.png' : 'image/png',
  '.jpg' : 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif' : 'image/gif',
  '.webp': 'image/webp',
  '.svg' : 'image/svg+xml',
  '.ico' : 'image/x-icon',
};

var server = http.createServer(function (req, res) {
  var pathname = url.parse(req.url).pathname;
  if (pathname === '/') pathname = '/index.html';

  var filepath = path.join(ROOT, pathname);

  /* Security: stay inside ROOT */
  if (filepath.indexOf(ROOT) !== 0) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filepath, function (err, data) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found: ' + pathname);
    }
    var ext  = path.extname(filepath).toLowerCase();
    var mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', function () {
  console.log('BAT-Viewer running at http://localhost:' + PORT);
});
