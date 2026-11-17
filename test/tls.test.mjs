import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import https from 'node:https';
import { initialize } from '../src/config.mjs';
import { createCoordinator } from '../src/server.mjs';
import { executeJob } from '../src/adapters.mjs';

test('HTTPS rejects untrusted certificates and accepts a trusted paired worker', { timeout: 15000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pocketfleet-tls-'));
  let coordinator;
  t.after(async () => { if (coordinator) await coordinator.close(); rmSync(directory, { recursive: true, force: true }); });
  const openssl = process.platform === 'win32' && existsSync('C:/Program Files/Git/usr/bin/openssl.exe')
    ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl';
  const cert = join(directory, 'cert.pem'); const key = join(directory, 'key.pem');
  execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-days', '1'], { stdio: 'pipe' });
  const { adminToken } = initialize(directory);
  coordinator = createCoordinator({ directory, adminToken, tls: { key: readFileSync(key), cert: readFileSync(cert) } });
  const address = await coordinator.listen(0);
  const request = (path, { token, body, trusted = true } = {}) => new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port: address.port, path,
      method: body ? 'POST' : 'GET', agent: false, timeout: 5000, ca: trusted ? readFileSync(cert) : undefined,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('HTTPS request timed out'))); req.end(body ? JSON.stringify(body) : undefined);
  });
  await assert.rejects(request('/health', { trusted: false }), /self-signed certificate/);
  assert.equal((await request('/api/state')).status, 401);
  const pairing = await request('/api/pairing', { token: adminToken, body: {} });
  const enrolled = await request('/api/enroll', { body: { code: pairing.body.code, name: 'TLS worker', capabilities: ['sha256'] } });
  const token = enrolled.body.token;
  await request('/api/jobs', { token: adminToken, body: { kind: 'sha256', payload: { text: 'encrypted job' } } });
  const claimed = await request('/api/worker/claim', { token, body: {} });
  const job = claimed.body.job;
  assert.equal((await request('/api/worker/complete', { token, body: { ...job, result: await executeJob(job) } })).status, 200);
  assert.equal((await request('/api/state', { token: adminToken })).body.jobs[0].status, 'completed');
});
