import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createServer } from 'node:http';
import { FleetStore } from '../src/store.mjs';
import { createCoordinator } from '../src/server.mjs';
import { executeJob } from '../src/adapters.mjs';
import { api, enrollWorker, processOne } from '../src/worker.mjs';
import { initialize, LIMITS, validateJob, validateServer, atomicJson } from '../src/config.mjs';

function fixture(t, options) {
  const directory = mkdtempSync(join(tmpdir(), 'pocketfleet-'));
  const { adminToken } = initialize(directory);
  const store = new FleetStore(directory, adminToken, options);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, adminToken, store };
}
function worker(store, capabilities = ['text-stats']) {
  const { code } = store.pairing();
  const credentials = store.enroll({ code, name: 'test worker', capabilities });
  return { ...credentials, record: store.worker(credentials.token) };
}
test('one-use enrollment, distinct credentials and secret-free snapshots', (t) => {
  const { store, adminToken } = fixture(t);
  const { code } = store.pairing();
  const enrolled = store.enroll({ code, name: 'desktop', capabilities: ['gzip'] });
  assert.throws(() => store.enroll({ code, name: 'again', capabilities: ['gzip'] }), /already used/);
  assert.equal(store.admin(enrolled.token), false);
  assert.equal(store.worker(adminToken), undefined);
  assert.equal(JSON.stringify(store.snapshot()).includes(enrolled.token), false);
  assert.equal(JSON.stringify(store.snapshot()).includes('tokenHash'), false);
});
test('expired pairing rejected and invalid capabilities do not consume code', (t) => {
  let now = Date.now(); const { store } = fixture(t, { now: () => now });
  const { code } = store.pairing();
  assert.throws(() => store.enroll({ code, name: 'node', capabilities: ['shell'] }), /capabilities/);
  now += LIMITS.pairingMs + 1;
  assert.throws(() => store.enroll({ code, name: 'node', capabilities: ['gzip'] }), /expired/);
});
test('capability dispatch claims only once and completion is worker/lease bound', (t) => {
  const { store } = fixture(t);
  const a = worker(store, ['gzip']); const b = worker(store, ['text-stats']);
  const queued = store.submit({ kind: 'text-stats', payload: { text: 'one two' } });
  assert.equal(store.claim(a.record).job, null);
  const { job } = store.claim(b.record);
  assert.equal(job.id, queued.id); assert.equal(store.claim(b.record).job, null);
  assert.throws(() => store.complete(a.record, { id: job.id, leaseToken: job.leaseToken, result: {} }), /lease/);
  assert.throws(() => store.complete(b.record, { id: job.id, leaseToken: 'wrong', result: {} }), /lease/);
  store.complete(b.record, { id: job.id, leaseToken: job.leaseToken, result: { words: 2 } });
  assert.equal(store.snapshot().jobs[0].status, 'completed');
  assert.throws(() => store.complete(b.record, { id: job.id, leaseToken: job.leaseToken, result: {} }), /lease/);
});
test('cancellation wins over late results; terminal cancellation is idempotent', (t) => {
  const { store } = fixture(t); const w = worker(store);
  const submitted = store.submit({ kind: 'text-stats', payload: { text: '' } });
  const { job } = store.claim(w.record);
  assert.equal(store.cancel(submitted.id).status, 'cancelled');
  assert.equal(store.cancel(submitted.id).status, 'cancelled');
  assert.throws(() => store.heartbeat(w.record, job), /lease/);
  assert.throws(() => store.complete(w.record, { ...job, result: {} }), /lease/);
});
test('lease expiry fails without retry; absolute deadline survives heartbeats', (t) => {
  let now = Date.now(); const { store } = fixture(t, { now: () => now }); const w = worker(store);
  store.submit({ kind: 'text-stats', payload: { text: 'a' } });
  store.claim(w.record); now += LIMITS.leaseMs + 1;
  assert.equal(store.snapshot().jobs[0].status, 'failed'); assert.equal(store.claim(w.record).job, null);
  store.submit({ kind: 'text-stats', payload: { text: 'b' } });
  const { job } = store.claim(w.record);
  for (let i = 0; i < 7; i++) { now += 15000; store.heartbeat(w.record, job); }
  now += 16000; assert.throws(() => store.heartbeat(w.record, job), /lease/);
  assert.match(store.snapshot().jobs[1].error, /deadline/);
});
test('worker revocation prevents further auth and fails in-flight work', (t) => {
  const { store } = fixture(t); const w = worker(store);
  store.submit({ kind: 'text-stats', payload: { text: 'hello' } }); store.claim(w.record);
  store.revoke(w.id);
  assert.equal(store.worker(w.token), undefined); assert.equal(store.snapshot().jobs[0].status, 'failed');
});
test('state persists and interrupted jobs are not silently replayed on restart', (t) => {
  const { store, directory, adminToken } = fixture(t); const w = worker(store);
  store.submit({ kind: 'text-stats', payload: { text: 'persist me' } }); store.claim(w.record); store.close();
  const next = new FleetStore(directory, adminToken); t.after(() => next.close());
  assert.equal(next.snapshot().jobs[0].status, 'failed'); assert.match(next.snapshot().jobs[0].error, /restarted/);
  assert.ok(next.worker(w.token)); next.close();
});
test('second coordinator cannot open a live state directory', (t) => {
  const { directory, adminToken } = fixture(t);
  assert.throws(() => new FleetStore(directory, adminToken), /already owns/);
});
test('strict payload and transport boundaries', () => {
  assert.throws(() => validateJob('shell', {}), /Unknown/);
  assert.throws(() => validateJob('gzip', { text: 'x', command: 'rm' }), /Unexpected/);
  assert.throws(() => validateJob('sha256', { text: 'é'.repeat(LIMITS.textBytes) }), /128 KiB/);
  assert.throws(() => validateJob('ollama', { model: 'qwen', prompt: '' }), /empty/);
  assert.throws(() => validateServer('http://192.168.1.2:4320'), /HTTPS/);
  assert.throws(() => validateServer('https://user:password@example.com'), /credentials/);
  assert.equal(validateServer('https://fleet.example.com'), 'https://fleet.example.com');
});
test('real adapters produce valid portable artifacts, Unicode and empty text results', async () => {
  const sha = await executeJob({ kind: 'sha256', payload: { text: 'hello' } });
  assert.equal(sha.digest, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  const compressed = await executeJob({ kind: 'gzip', payload: { text: 'hello 🌍' } });
  assert.equal(gunzipSync(Buffer.from(compressed.data, 'base64')).toString(), 'hello 🌍');
  const stats = await executeJob({ kind: 'text-stats', payload: { text: 'Hello hello\nworld' } });
  assert.equal(stats.words, 3); assert.deepEqual(stats.topWords[0], { word: 'hello', count: 2 });
  assert.equal((await executeJob({ kind: 'text-stats', payload: { text: '' } })).lines, 0);
});
test('Ollama adapter performs real HTTP request without accepting a job-supplied endpoint', async (t) => {
  let received;
  const model = createServer(async (req, res) => { const chunks = []; for await (const c of req) chunks.push(c); received = JSON.parse(Buffer.concat(chunks)); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ response: 'fixture model response', eval_count: 3 })); });
  await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { model.closeAllConnections(); model.close(resolve); }));
  const result = await executeJob({ kind: 'ollama', payload: { model: 'fixture', prompt: 'hi' } }, { ollama: `http://127.0.0.1:${model.address().port}` });
  assert.equal(result.response, 'fixture model response'); assert.equal(received.stream, false); assert.equal(received.options.num_predict, 1024);
});
test('two real HTTP workers execute jobs with role separation and cross-origin protection', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pocketfleet-http-'));
  const { adminToken } = initialize(directory);
  const coordinator = createCoordinator({ directory, adminToken });
  const address = await coordinator.listen(0); const server = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await coordinator.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal((await fetch(`${server}/health`)).status, 200);
  assert.equal((await fetch(`${server}/api/state`)).status, 401);
  assert.equal((await fetch(`${server}/api/state`, { headers: { Authorization: `Bearer ${adminToken}`, Origin: 'https://evil.example' } })).status, 403);
  const firstCode = await api(server, '/api/pairing', { token: adminToken });
  const secondCode = await api(server, '/api/pairing', { token: adminToken });
  const a = await enrollWorker({ server, code: firstCode.code, name: 'alpha' });
  const b = await enrollWorker({ server, code: secondCode.code, name: 'beta' });
  await assert.rejects(api(server, '/api/state', { token: a.token, method: 'GET' }), /Admin/);
  for (const kind of ['sha256', 'gzip']) await api(server, '/api/jobs', { token: adminToken, body: { kind, payload: { text: 'distributed work' } } });
  await Promise.all([processOne({ server, token: a.token }), processOne({ server, token: b.token })]);
  const state = await api(server, '/api/state', { token: adminToken, method: 'GET' });
  assert.ok(state.jobs.every((job) => job.status === 'completed'));
  assert.equal(new Set(state.jobs.map((job) => job.workerId)).size, 2);
  const detail = await api(server, `/api/jobs/${state.jobs[1].id}`, { token: adminToken, method: 'GET' });
  assert.equal(gunzipSync(Buffer.from(detail.result.data, 'base64')).toString(), 'distributed work');
  assert.equal(state.jobs[1].result, undefined);
  const cleared = await api(server, '/api/jobs/completed', { token: adminToken, method: 'DELETE' }); assert.equal(cleared.deleted, 2);
});
test('idle claims and heartbeats never rewrite retained history', (t) => {
  let writes = 0;
  const { store } = fixture(t, { persist: (...args) => { writes++; atomicJson(...args); } });
  const w = worker(store); const beforeIdle = writes;
  store.claim(w.record); store.claim(w.record); assert.equal(writes, beforeIdle);
  store.submit({ kind: 'text-stats', payload: { text: 'hello' } });
  const { job } = store.claim(w.record); const beforePulse = writes;
  store.heartbeat(w.record, job); store.claim(w.record); assert.equal(writes, beforePulse);
});
test('failed durable save rolls back rejected work and stops all future dispatch', (t) => {
  let failed = false;
  const { store } = fixture(t, { persist: (...args) => { if (failed) throw new Error('disk full'); atomicJson(...args); } });
  const w = worker(store); failed = true;
  assert.throws(() => store.submit({ kind: 'text-stats', payload: { text: 'must not execute' } }), /Dispatch is stopped/);
  assert.equal(store.data.jobs.length, 0);
  assert.throws(() => store.claim(w.record), /Dispatch is stopped/);
  assert.throws(() => store.snapshot(), /Dispatch is stopped/);
});
test('empty or ambiguous completions cannot masquerade as success', (t) => {
  const { store } = fixture(t); const w = worker(store);
  store.submit({ kind: 'text-stats', payload: { text: '' } }); const { job } = store.claim(w.record);
  assert.throws(() => store.complete(w.record, { ...job, error: '' }), /nonempty/);
  assert.throws(() => store.complete(w.record, { ...job, result: {}, error: 'both' }), /exactly one/);
  assert.equal(store.detail(job.id).status, 'running');
});
test('total state cap rejects excess output without losing last durable job state', (t) => {
  const { store } = fixture(t);
  const saved = store.data;
  store.data = { ...saved, junk: 'x'.repeat(LIMITS.stateBytes) };
  assert.throws(() => store.save(), /16 MiB/);
  assert.equal(store.data.junk, undefined); assert.equal(store.persistenceFailed, false);
});
