'use strict';
/*
 * Local development server.
 *   - serves the static site (like GitHub Pages)
 *   - answers /api by running the real apps-script/Code.gs against fake Google services
 *
 * Usage:  node dev/server.js        (env: PORT=4321, ADMIN_PASSWORD, LATENCY_MS=400)
 * The local admin password is read from dev/.admin-password (git-ignored) when ADMIN_PASSWORD is not set.
 * Data is kept in dev/.data/ – delete that folder to start fresh.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadBackend } = require('./gas-fakes');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 4321);
const LATENCY_MS = Number(process.env.LATENCY_MS || 400); // Apps Script is not instant – mimic it
// Admin password: env ADMIN_PASSWORD, else dev/.admin-password (git-ignored, so never published), else a default.
const PASSWORD_FILE = path.join(__dirname, '.admin-password');
const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD || (fs.existsSync(PASSWORD_FILE) ? fs.readFileSync(PASSWORD_FILE, 'utf8').trim() : '') || 'florist-dev';
const MAX_BODY = 8 * 1024 * 1024;

const backend = loadBackend(path.join(__dirname, '.data'));
backend.setProperty('ADMIN_PASSWORD', ADMIN_PASSWORD);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};
const BLOCKED = /^\/(dev|apps-script|\.git)(\/|$)/;

function sendJson(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

function handleApi(req, res) {
  if (req.method === 'GET') return sendJson(res, backend.doGet());
  if (req.method !== 'POST') {
    // Apps Script web apps do not answer CORS preflight requests – fail the same way.
    res.writeHead(405);
    return res.end();
  }
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) req.destroy();
    else chunks.push(c);
  });
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    let action = '?';
    try {
      action = JSON.parse(body).action;
    } catch (e) {
      /* logged as ? */
    }
    setTimeout(() => {
      const out = backend.doPost(body);
      const ok = JSON.parse(out).ok;
      console.log(`${new Date().toISOString().slice(11, 19)}  POST /api ${action} → ${ok ? 'ok' : JSON.parse(out).error}`);
      sendJson(res, out);
    }, LATENCY_MS);
  });
}

function handleStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT + path.sep) || BLOCKED.test(rel.replace(/\\/g, '/'))) {
    res.writeHead(404);
    return res.end('Not found');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

http
  .createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/api') return handleApi(req, res);
    return handleStatic(req, res, pathname);
  })
  .listen(PORT, () => {
    console.log(`Wedding questionnaire dev server: http://localhost:${PORT}/admin.html`);
    console.log(`Admin password: ${ADMIN_PASSWORD}`);
  });
