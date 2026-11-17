import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { gunzipSync } from 'node:zlib';
import { initialize } from './config.mjs';
import { createCoordinator } from './server.mjs';
import { api } from './worker.mjs';

const sample = 'PocketFleet dispatch log\n' + 'worker ready; queue accepting jobs\n'.repeat(8);
const adapters = [
  { name: 'Demo · Text worker', capabilities: ['text-stats', 'sha256'] },
  { name: 'Demo · Archive worker', capabilities: ['gzip'] },
];

export async function demo({ once = false } = {}) {
  const directory = await mkdtemp(join(resolve(tmpdir()), 'pocketfleet-demo-'));
  const workers = [];
  const controller = new AbortController();
  const stop = () => controller.abort();
  let coordinator;
  let failure;
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const { adminToken } = initialize(directory);
    coordinator = createCoordinator({ directory, adminToken });
    const address = await coordinator.listen(0);
    const server = 'http://127.0.0.1:' + address.port;
    for (const adapter of adapters) {
      const { code } = await api(server, '/api/pairing', { token: adminToken });
      const { token } = await api(server, '/api/enroll', { body: { code, ...adapter } });
      const child = fork(new URL('./demo-worker.mjs', import.meta.url), [], { silent: true, execArgv: [], windowsHide: true });
      child.stderr.resume();
      child.stdout.resume();
      const closed = new Promise((resolveClosed) => {
        child.once('exit', resolveClosed);
        child.once('error', resolveClosed);
      });
      workers.push({ child, closed });
      const failed = () => {
        if (controller.signal.aborted) return;
        failure = new Error(adapter.name + ' stopped unexpectedly.');
        stop();
      };
      child.once('error', failed);
      child.once('exit', failed);
      child.send({ server, token }, (error) => { if (error) failed(); });
    }
    const jobs = [];
    for (const kind of ['text-stats', 'gzip']) {
      const job = await api(server, '/api/jobs', { token: adminToken, body: { kind, payload: { text: sample } } });
      jobs.push(job.id);
    }
    const deadline = Date.now() + 20_000;
    let finished;
    while (!controller.signal.aborted) {
      finished = await Promise.all(jobs.map((id) => api(server, '/api/jobs/' + id, { token: adminToken, method: 'GET' })));
      if (finished.every((job) => job.status === 'completed')) break;
      if (finished.some((job) => job.status === 'failed') || Date.now() >= deadline) throw new Error('Demo workers could not complete the sample jobs in time.');
      await delay(100);
    }
    if (failure) throw failure;
    if (controller.signal.aborted) return;
    const [stats, archive] = finished;
    if (stats.workerId === archive.workerId || gunzipSync(Buffer.from(archive.result.data, 'base64')).toString() !== sample) {
      throw new Error('Demo artifact verification failed.');
    }
    console.log('Text worker     ' + stats.result.words + ' words counted');
    console.log('Archive worker  ' + archive.result.inputBytes + ' bytes compressed to ' + archive.result.outputBytes + ' bytes (round-trip verified)');
    if (!once) {
      console.log('Open ' + server + ' and sign in with this temporary admin token:\n' + adminToken);
      console.log('Inspect the two finished jobs or queue your own. Ctrl+C closes this temporary fleet.');
      if (!controller.signal.aborted) await new Promise((done) => controller.signal.addEventListener('abort', done, { once: true }));
      if (failure) throw failure;
    }
  } finally {
    stop();
    for (const { child } of workers) if (child.connected) child.disconnect();
    await Promise.all(workers.map(({ closed }) => closed));
    if (coordinator?.server.listening) await coordinator.close();
    else coordinator?.store.close();
    if (dirname(directory) === resolve(tmpdir()) && basename(directory).startsWith('pocketfleet-demo-')) {
      await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    }
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
