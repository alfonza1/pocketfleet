import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { FleetStore } from './store.mjs';
import { LIMITS, requireValue, hash } from './config.mjs';

const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
const ASSETS = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/mark.svg': ['mark.svg', 'image/svg+xml'] };
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
async function readBody(request) {
  requireValue(request.headers['content-type']?.split(';')[0] === 'application/json', 'Use Content-Type: application/json.', 415);
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length; requireValue(size <= LIMITS.bodyBytes, 'Request exceeds 1 MiB.', 413); chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requireValue(body && typeof body === 'object' && !Array.isArray(body), 'JSON body must be an object.');
    return body;
  } catch (error) { if (error.status) throw error; throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
}
export function createCoordinator({ directory, adminToken, host = '127.0.0.1', tls, allowInsecure = false, now, lock = true }) {
  const localBind = ['127.0.0.1', 'localhost', '::1'].includes(host);
  requireValue(localBind || tls || allowInsecure, 'Binding beyond loopback requires TLS certificates or explicit --allow-insecure-lan.');
  const store = new FleetStore(directory, adminToken, { now, lock });
  const rates = new Map();
  function json(response, status, body) {
    response.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(body));
  }
  const handler = async (request, response) => {
    try {
      const requestHost = request.headers.host;
      requireValue(requestHost, 'Host header required.');
      const origin = `${tls ? 'https' : 'http'}://${requestHost}`;
      const url = new URL(request.url, origin);
      requireValue(!request.headers.origin || request.headers.origin === origin, 'Cross-origin requests are not allowed.', 403);
      if (localBind) requireValue(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname), 'Unrecognized host.', 403);
      const token = request.headers.authorization?.match(/^Bearer ([^ ]+)$/)?.[1];
      const worker = store.worker(token);
      const admin = store.admin(token);
      const address = admin ? 'admin' : worker ? `worker:${worker.id}` : `anonymous:${request.socket.remoteAddress}`;
      const rateLimit = admin || worker ? LIMITS.identityRequestsPerMinute : LIMITS.anonymousRequestsPerMinute;
      const minute = Math.floor(Date.now() / 60_000);
      const rate = rates.get(address);
      if (!rate || rate.minute !== minute) {
        requireValue(rate || rates.size < LIMITS.maxRateEntries, 'Server is busy. Try again shortly.', 429);
        rates.set(address, { minute, count: 1 });
      } else requireValue(++rate.count <= rateLimit, 'Request limit reached. Try again in one minute.', 429);
      if (request.method === 'GET' && url.pathname === '/health') return json(response, store.persistenceFailed ? 503 : 200, { ok: !store.persistenceFailed, version: '0.2.0' });
      if (request.method === 'GET' && Object.hasOwn(ASSETS, url.pathname)) {
        const [name, contentType] = ASSETS[url.pathname];
        response.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': `${contentType}; charset=utf-8` });
        response.end(readFileSync(join(publicDirectory, name))); return;
      }
      store.assertHealthy();
      if (request.method === 'POST' && url.pathname === '/api/enroll') return json(response, 201, store.enroll(await readBody(request)));
      const workerPath = url.pathname.startsWith('/api/worker/');
      if (workerPath) {
        requireValue(worker, 'Worker authentication required.', 401);
        requireValue(request.method === 'POST', 'Method not allowed.', 405);
        if (url.pathname === '/api/worker/claim') return json(response, 200, store.claim(worker));
        if (url.pathname === '/api/worker/heartbeat') return json(response, 200, store.heartbeat(worker, await readBody(request)));
        if (url.pathname === '/api/worker/complete') return json(response, 200, store.complete(worker, await readBody(request)));
      } else {
        requireValue(admin, 'Admin authentication required.', 401);
        if (request.method === 'GET' && url.pathname === '/api/state') return json(response, 200, store.snapshot());
        if (request.method === 'GET' && url.pathname === '/api/backup') {
          store.expire();
          return json(response, 200, { format: 'pocketfleet-backup', version: 1, createdAt: store.timestamp(), coordinatorHash: hash(adminToken), state: structuredClone(store.data) });
        }
        const detail = url.pathname.match(/^\/api\/jobs\/([\w-]+)$/);
        if (request.method === 'GET' && detail) return json(response, 200, store.detail(detail[1]));
        if (request.method === 'POST' && url.pathname === '/api/pairing') return json(response, 201, store.pairing());
        if (request.method === 'POST' && url.pathname === '/api/jobs') return json(response, 201, store.submit(await readBody(request), request.headers['idempotency-key']));
        if (request.method === 'DELETE' && url.pathname === '/api/jobs/completed') return json(response, 200, store.clearCompleted());
        const cancel = url.pathname.match(/^\/api\/jobs\/([\w-]+)\/cancel$/);
        if (request.method === 'POST' && cancel) return json(response, 200, store.cancel(cancel[1]));
        const revoke = url.pathname.match(/^\/api\/workers\/([\w-]+)$/);
        if (request.method === 'DELETE' && revoke) return json(response, 200, store.revoke(revoke[1]));
      }
      json(response, 404, { error: 'Route not found.' });
    } catch (error) {
      if (!response.headersSent && !response.destroyed) json(response, error.status ?? 500, { error: error.status ? error.message : 'Coordinator could not complete the request.' });
    }
  };
  const options = { requestTimeout: 15_000, headersTimeout: 10_000, maxHeaderSize: 8192, keepAliveTimeout: 5000 };
  let server;
  try { server = tls ? https.createServer({ ...options, ...tls }, handler) : http.createServer(options, handler); }
  catch (error) { store.close(); throw error; }
  const sweep = setInterval(() => {
    if (!store.persistenceFailed) { try { store.expire(); } catch { /* API reports unavailable until restart. */ } }
    const minute = Math.floor(Date.now() / 60_000);
    for (const [ip, rate] of rates) if (rate.minute !== minute) rates.delete(ip);
  }, 5000);
  sweep.unref();
  server.on('close', () => { clearInterval(sweep); store.close(); });
  return { server, store, listen: (port = 4320) => new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(server.address()); });
  }), close: () => new Promise((resolve, reject) => {
    server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve());
  }) };
}
