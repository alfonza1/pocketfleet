import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { FleetStore } from '../src/store.mjs';
import { createCoordinator } from '../src/server.mjs';
import { initialize, hash, LIMITS, atomicJson, matches } from '../src/config.mjs';
import { api, enrollWorker, reportCompletion, runWorker } from '../src/worker.mjs';
import { inspectDirectory, restoreBackup, writeBackup } from '../src/maintenance.mjs';
import { readFleetState } from '../src/state-file.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pocketfleet-harden-'));
  const { adminToken } = initialize(directory);
  const store = new FleetStore(directory, adminToken);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, adminToken, store };
}
function pair(store) {
  const credentials = store.enroll({ code: store.pairing().code, name: 'test worker', capabilities: ['text-stats'] });
  return { ...credentials, record: store.worker(credentials.token) };
}
async function httpFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pocketfleet-hardhttp-'));
  const { adminToken } = initialize(directory);
  const coordinator = createCoordinator({ directory, adminToken });
  const address = await coordinator.listen(0);
  t.after(async () => { await coordinator.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, adminToken, coordinator, server: `http://127.0.0.1:${address.port}` };
}
function archive(store, adminToken) {
  return { format: 'pocketfleet-backup', version: 1, coordinatorHash: hash(adminToken), createdAt: new Date().toISOString(), state: structuredClone(store.data) };
}
function cli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), ...args], { windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject); child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

test('idempotent submit survives restart, rejects reuse and hides internal key', (t) => {
  const { store, directory, adminToken } = fixture(t);
  const request = { kind: 'ollama', payload: { prompt: 'hello', model: 'local' } };
  const first = store.submit(request, 'request-1');
  assert.equal(store.submit({ kind: 'ollama', payload: { model: 'local', prompt: 'hello' } }, 'request-1').id, first.id);
  assert.equal(first.idempotencyKey, undefined);
  assert.throws(() => store.submit({ ...request, payload: { ...request.payload, prompt: 'different' } }, 'request-1'), /different job/);
  assert.throws(() => store.submit(request, 'spaces not allowed'), /Idempotency-Key/);
  store.close(); const reopened = new FleetStore(directory, adminToken);
  try { assert.equal(reopened.submit(request, 'request-1').id, first.id); assert.equal(reopened.data.jobs.length, 1); }
  finally { reopened.close(); }
});

test('a committed completion can be acknowledged again after restart without overwriting it', (t) => {
  const { store, directory, adminToken } = fixture(t); const worker = pair(store);
  store.submit({ kind: 'text-stats', payload: { text: 'two words' } });
  const { job } = store.claim(worker.record); const completion = { ...job, result: { words: 2 } };
  store.complete(worker.record, completion);
  assert.equal(store.detail(job.id).completionReceipt, undefined);
  assert.equal(store.snapshot().jobs[0].completionReceipt, undefined);
  store.close(); const reopened = new FleetStore(directory, adminToken);
  try {
    assert.equal(reopened.complete(reopened.worker(worker.token), completion).status, 'completed');
    assert.throws(() => reopened.complete(reopened.worker(worker.token), { ...completion, result: { words: 9 } }), /different result/);
    assert.equal(reopened.detail(job.id).result.words, 2);
  } finally { reopened.close(); }
});

test('lost completion acknowledgement retries the same payload without executing twice', async (t) => {
  const { server, adminToken } = await httpFixture(t);
  const { code } = await api(server, '/api/pairing', { token: adminToken });
  const worker = await enrollWorker({ server, code, name: 'network recovery' });
  await api(server, '/api/jobs', { token: adminToken, body: { kind: 'text-stats', payload: { text: 'one' } } });
  const { job } = await api(server, '/api/worker/claim', { token: worker.token });
  let attempts = 0;
  await reportCompletion(server, { token: worker.token, body: { id: job.id, leaseToken: job.leaseToken, result: { words: 1 } } }, {
    sleep: async () => {}, request: async (...args) => {
      const result = await api(...args);
      if (++attempts === 1) throw new Error('Simulated lost response after durable commit');
      return result;
    },
  });
  assert.equal(attempts, 2);
  assert.equal((await api(server, '/api/state', { token: adminToken, method: 'GET' })).jobs[0].status, 'completed');
});

test('completion retry is bounded and never retries authentication failure', async () => {
  let attempts = 0;
  const request = async () => { attempts++; throw new Error('offline'); };
  await assert.rejects(reportCompletion('http://unused', {}, { request, sleep: async () => {} }), /offline/);
  assert.equal(attempts, LIMITS.completionAttempts);
  attempts = 0;
  await assert.rejects(reportCompletion('http://unused', {}, { sleep: async () => {}, request: async () => {
    attempts++; throw Object.assign(new Error('revoked'), { status: 401 });
  } }), /revoked/);
  assert.equal(attempts, 1);
});

test('worker reconnect uses bounded backoff and stops on cancellation', async () => {
  const controller = new AbortController(); const pauses = [];
  await runWorker({ server: 'http://127.0.0.1:1', token: 'unused', signal: controller.signal }, {
    random: () => 1,
    sleep: async (duration) => { pauses.push(duration); if (pauses.length === 7) controller.abort(); },
  });
  assert.deepEqual(pauses, [2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});

test('startup preserves malformed state byte-for-byte and releases its lock', (t) => {
  const { store, directory, adminToken } = fixture(t); store.close();
  const path = join(directory, 'state.json');
  for (const invalid of ['{broken', JSON.stringify({ version: 1, workers: [null], jobs: [], pairings: [] }), JSON.stringify({ version: 1, workers: [], jobs: [{ id: 'bad' }], pairings: [] })]) {
    writeFileSync(path, invalid);
    assert.throws(() => new FleetStore(directory, adminToken), /Invalid fleet state/);
    assert.equal(readFileSync(path, 'utf8'), invalid);
    assert.equal(existsSync(join(directory, 'coordinator.lock')), false);
  }
});

test('schema rejects corrupt credentials, duplicate ids and oversized state', (t) => {
  const { store, directory } = fixture(t); pair(store); store.close();
  const path = join(directory, 'state.json'); const original = readFileSync(path, 'utf8'); const data = JSON.parse(original);
  data.workers[0].tokenHash = 'z'.repeat(64); writeFileSync(path, JSON.stringify(data));
  assert.throws(() => readFleetState(path), /Invalid fleet state/);
  assert.equal(matches('token', 'z'.repeat(64)), false);
  const duplicate = JSON.parse(original); duplicate.workers.push(duplicate.workers[0]); writeFileSync(path, JSON.stringify(duplicate));
  assert.throws(() => readFleetState(path), /Invalid fleet state/);
  writeFileSync(path, ' '.repeat(LIMITS.stateBytes * 2 + 1));
  assert.throws(() => readFleetState(path), /Invalid fleet state/);
});

test('atomic writes avoid a predictable temporary file and keep restrictive permissions', (t) => {
  const { directory } = fixture(t); const path = join(directory, 'settings.json');
  writeFileSync(`${path}.tmp`, 'unrelated sentinel'); atomicJson(path, { value: 'new' });
  assert.equal(readFileSync(`${path}.tmp`, 'utf8'), 'unrelated sentinel');
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { value: 'new' });
  assert.equal(readdirSync(directory).filter((name) => /^settings.json\.\d+\./.test(name)).length, 0);
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('backup refuses overwrite and CLI restore preserves old state without replay or credential resurrection', async (t) => {
  const { store, directory, adminToken } = fixture(t); const worker = pair(store);
  store.submit({ kind: 'text-stats', payload: { text: 'running' } }); store.claim(worker.record);
  store.submit({ kind: 'text-stats', payload: { text: 'queued' } });
  const file = join(directory, 'backup.json'); writeBackup(file, archive(store, adminToken));
  assert.throws(() => writeBackup(file, archive(store, adminToken)), /EEXIST/);
  assert.throws(() => restoreBackup(directory, file, { replace: true }), /Stop the coordinator/);
  store.close(); const before = readFileSync(join(directory, 'state.json'), 'utf8');
  assert.throws(() => restoreBackup(directory, file), /--replace/);
  const restoredCli = await cli(['restore', '--dir', directory, '--file', file, '--replace']);
  assert.equal(restoredCli.code, 0, restoredCli.stderr);
  const result = JSON.parse(restoredCli.stdout);
  assert.equal(readFileSync(result.preserved, 'utf8'), before);
  const restored = readFleetState(join(directory, 'state.json'));
  assert.equal(restored.workers.length, 0); assert.equal(restored.pairings.length, 0);
  assert.ok(restored.jobs.every((job) => job.status === 'failed' && !job.leaseToken));
  assert.equal(inspectDirectory(directory).ok, true);
});

test('restore refuses foreign or corrupt backups before touching state', (t) => {
  const { store, directory, adminToken } = fixture(t); const backup = archive(store, adminToken); store.close();
  const before = readFileSync(join(directory, 'state.json'), 'utf8'); const file = join(directory, 'backup.json');
  backup.coordinatorHash = '0'.repeat(64); writeFileSync(file, JSON.stringify(backup));
  assert.throws(() => restoreBackup(directory, file, { replace: true }), /different coordinator/);
  backup.coordinatorHash = hash(adminToken); backup.state.jobs = [null]; writeFileSync(file, JSON.stringify(backup));
  assert.throws(() => restoreBackup(directory, file, { replace: true }), /Invalid fleet state/);
  assert.equal(readFileSync(join(directory, 'state.json'), 'utf8'), before);
});

test('real CLI doctor and live backup protect credentials and produce a validated archive', async (t) => {
  const { directory, server, coordinator, adminToken } = await httpFixture(t);
  const created = await api(server, '/api/jobs', { token: adminToken, idempotencyKey: 'real-client', body: { kind: 'text-stats', payload: { text: 'retain me' } } });
  const repeated = await api(server, '/api/jobs', { token: adminToken, idempotencyKey: 'real-client', body: { kind: 'text-stats', payload: { text: 'retain me' } } });
  assert.equal(repeated.id, created.id);
  const file = join(directory, 'cli-backup.json');
  const backup = await cli(['backup', '--dir', directory, '--server', server, '--file', file]);
  assert.equal(backup.code, 0, backup.stderr); assert.ok(existsSync(file));
  assert.ok(!readFileSync(file, 'utf8').includes(adminToken));
  const doctor = await cli(['doctor', '--dir', directory]);
  assert.equal(doctor.code, 0, doctor.stderr); assert.equal(JSON.parse(doctor.stdout).ok, true); assert.ok(!doctor.stdout.includes(adminToken));
  const { code } = await api(server, '/api/pairing', { token: adminToken });
  const worker = await enrollWorker({ server, code, name: 'roles' });
  await assert.rejects(api(server, '/api/backup', { token: worker.token, method: 'GET' }), /Admin/);
  // Restore is verified offline separately; never close the fixture twice.
  assert.equal(coordinator.store.data.jobs.length, 1);
});

test('a failed backup flush never publishes an incomplete destination', (t) => {
  const { store, directory, adminToken } = fixture(t);
  const file = join(directory, 'failed-backup.json');
  t.mock.method(fs, 'fsyncSync', () => { throw Object.assign(new Error('simulated disk flush failure'), { code: 'ENOSPC' }); });
  syncBuiltinESMExports();
  try {
    assert.throws(() => writeBackup(file, archive(store, adminToken)), /disk flush failure/);
    assert.equal(existsSync(file), false);
    assert.equal(readdirSync(directory).filter((name) => name.startsWith('failed-backup.json')).length, 0);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('workers behind one IP have independent rate budgets and malformed routes remain bounded', async (t) => {
  const { server, adminToken } = await httpFixture(t);
  const workers = [];
  for (const name of ['first', 'second']) {
    const { code } = await api(server, '/api/pairing', { token: adminToken });
    workers.push(await enrollWorker({ server, code, name }));
  }
  for (let count = 0; count < LIMITS.identityRequestsPerMinute; count++) await api(server, '/api/worker/claim', { token: workers[0].token });
  await assert.rejects(api(server, '/api/worker/claim', { token: workers[0].token }), /Request limit/);
  assert.equal((await api(server, '/api/worker/claim', { token: workers[1].token })).job, null);
  assert.equal((await fetch(`${server}/toString`, { headers: { Authorization: `Bearer ${adminToken}` } })).status, 404);
  const malformed = await fetch(`${server}/api/jobs`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }, body: 'null' });
  assert.equal(malformed.status, 400);
});

test('a real CLI worker cancels a slow model request and continues processing jobs', { timeout: 20000 }, async (t) => {
  const { server, directory, adminToken } = await httpFixture(t);
  let modelStarted = false; let modelDisconnected = false;
  const model = createServer((request, response) => {
    request.resume(); modelStarted = true;
    const timer = setTimeout(() => response.end(JSON.stringify({ response: 'too late' })), 15000);
    response.on('close', () => { clearTimeout(timer); modelDisconnected = true; });
  });
  await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { model.closeAllConnections(); model.close(resolve); }));
  const { code } = await api(server, '/api/pairing', { token: adminToken });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), 'worker',
    '--server', server, '--dir', join(directory, 'worker-process'), '--code', code,
    '--ollama', `http://127.0.0.1:${model.address().port}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stdout.resume(); child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-3000); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
    }
  });
  const waitUntil = async (check) => {
    const deadline = Date.now() + 10000;
    while (!(await check())) { assert.ok(Date.now() < deadline, `Timed out waiting for CLI worker: ${stderr}`); await delay(50); }
  };
  const job = await api(server, '/api/jobs', { token: adminToken, body: { kind: 'ollama', payload: { model: 'fixture', prompt: 'slow' } } });
  await waitUntil(() => modelStarted);
  await api(server, `/api/jobs/${job.id}/cancel`, { token: adminToken });
  await waitUntil(() => modelDisconnected);
  const next = await api(server, '/api/jobs', { token: adminToken, body: { kind: 'text-stats', payload: { text: 'worker recovered' } } });
  await waitUntil(async () => (await api(server, `/api/jobs/${next.id}`, { token: adminToken, method: 'GET' })).status === 'completed');
  assert.equal((await api(server, `/api/jobs/${job.id}`, { token: adminToken, method: 'GET' })).status, 'cancelled');
});
