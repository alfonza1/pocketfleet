import { setTimeout as delay } from 'node:timers/promises';
import { LIMITS, validateServer } from './config.mjs';
import { executeJob } from './adapters.mjs';

export async function api(server, path, { token, method = 'POST', body, signal, idempotencyKey } = {}) {
  const response = await fetch(`${server}${path}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error',
    signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(10_000)]),
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error ?? `HTTP ${response.status}`), { status: response.status });
  return result;
}
export async function enrollWorker({ server, code, name, ollama, allowInsecure = false }) {
  server = validateServer(server, allowInsecure);
  const capabilities = ['sha256', 'gzip', 'text-stats', ...(ollama ? ['ollama'] : [])];
  return { ...await api(server, '/api/enroll', { body: { code, name, capabilities } }), server, capabilities };
}
export async function reportCompletion(server, options, { request = api, sleep = delay } = {}) {
  for (let attempt = 0; attempt < LIMITS.completionAttempts; attempt++) {
    try { return await request(server, '/api/worker/complete', options); }
    catch (error) {
      if (error.status === 409) return;
      const retryable = !error.status || error.status === 429 || error.status >= 500;
      if (options.signal?.aborted || !retryable || attempt + 1 === LIMITS.completionAttempts) throw error;
      await sleep(500 * 2 ** attempt, undefined, { signal: options.signal });
    }
  }
}

export async function processOne({ server, token, ollama, signal, execute = executeJob }) {
  const { job } = await api(server, '/api/worker/claim', { token, signal });
  if (!job) return false;
  const controller = new AbortController();
  const taskSignal = AbortSignal.any([controller.signal, signal ?? new AbortController().signal, AbortSignal.timeout(LIMITS.jobTimeoutMs)]);
  let pulseBusy = false;
  const pulse = setInterval(async () => {
    if (pulseBusy) return; pulseBusy = true;
    try { await api(server, '/api/worker/heartbeat', { token, body: { id: job.id, leaseToken: job.leaseToken }, signal: taskSignal }); }
    catch { controller.abort(new Error('Worker lost its job lease.')); }
    finally { pulseBusy = false; }
  }, LIMITS.heartbeatMs);
  try {
    let completion;
    try { completion = { result: await execute(job, { ollama, signal: taskSignal }) }; }
    catch (error) { completion = { error: String(error.message).slice(0, 1000) }; }
    if (!signal?.aborted) {
      await reportCompletion(server, { token, body: { id: job.id, leaseToken: job.leaseToken, ...completion }, signal });
    }
  } finally { clearInterval(pulse); controller.abort(); }
  return true;
}
export async function runWorker(options, { sleep = delay, random = Math.random } = {}) {
  let failures = 0;
  while (!options.signal?.aborted) {
    try { await processOne(options); failures = 0; }
    catch (error) {
      if (options.signal?.aborted) break;
      if ([401, 403].includes(error.status)) throw error;
      failures++;
      options.onError?.(error);
    }
    const backoff = failures ? Math.min(LIMITS.retryMaxMs, LIMITS.pollMs * 2 ** Math.min(failures, 10)) * (0.75 + random() * 0.25) : LIMITS.pollMs;
    try { await sleep(backoff, undefined, { signal: options.signal }); } catch { break; }
  }
}
