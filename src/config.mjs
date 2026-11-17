import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, openSync, closeSync, fsyncSync, unlinkSync, linkSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

export const LIMITS = Object.freeze({
  textBytes: 128 * 1024, bodyBytes: 1024 * 1024, resultBytes: 512 * 1024,
  maxJobs: 500, maxWorkers: 32, maxPairings: 16, stateBytes: 16 * 1024 * 1024,
  pairingMs: 5 * 60_000, heartbeatMs: 3_000, leaseMs: 20_000,
  jobTimeoutMs: 120_000, offlineMs: 15_000, pollMs: 1_000,
  retryMaxMs: 30_000, completionAttempts: 3, identityRequestsPerMinute: 600,
  anonymousRequestsPerMinute: 120, maxRateEntries: 4096,
  workerNameChars: 64,
});
export const KINDS = ['sha256', 'gzip', 'text-stats', 'ollama'];
export const secret = () => randomBytes(32).toString('hex');
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const workerNameFromHostname = (value) => value.trim().slice(0, LIMITS.workerNameChars) || 'worker';
export function matches(value, digest) {
  return typeof value === 'string' && typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest)
    && timingSafeEqual(Buffer.from(hash(value), 'hex'), Buffer.from(digest, 'hex'));
}
export function atomicJson(path, value, { exclusive = false } = {}) {
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, JSON.stringify(value));
    fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined;
    if (exclusive) linkSync(temporary, path);
    else renameSync(temporary, path);
    // Windows does not expose a portable directory fsync through Node.
    if (process.platform !== 'win32') {
      descriptor = openSync(dirname(path), 'r'); fsyncSync(descriptor);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
export function initialize(directory) {
  const dir = resolve(directory);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'config.json');
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify({ version: 1, adminToken: secret() }, null, 2), { mode: 0o600, flag: 'wx' });
  }
  return readConfig(dir);
}
export function readConfig(directory) {
  const config = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8'));
  if (!config || config.version !== 1 || !/^[a-f0-9]{64}$/.test(config.adminToken)) throw new Error('Invalid configuration. Restore your config.json backup.');
  return config;
}
export function requireValue(condition, message, status = 400) {
  if (!condition) throw Object.assign(new Error(message), { status });
}
export function validateJob(kind, payload) {
  requireValue(KINDS.includes(kind), `Unknown job kind. Choose ${KINDS.join(', ')}.`);
  requireValue(payload && typeof payload === 'object' && !Array.isArray(payload), 'payload must be an object.');
  const allowed = kind === 'ollama' ? ['model', 'prompt'] : ['text'];
  requireValue(Object.keys(payload).every((key) => allowed.includes(key)), 'Unexpected payload field.');
  const text = kind === 'ollama' ? payload.prompt : payload.text;
  requireValue(typeof text === 'string', `${kind === 'ollama' ? 'prompt' : 'text'} must be a string.`);
  requireValue(Buffer.byteLength(text) <= LIMITS.textBytes, 'Text exceeds 128 KiB.');
  if (kind === 'ollama') {
    requireValue(typeof payload.model === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/.test(payload.model), 'Provide a valid installed Ollama model name.');
    requireValue(text.trim().length > 0, 'Prompt cannot be empty.');
  }
  return kind === 'ollama' ? { model: payload.model, prompt: text } : { text };
}
export function validateServer(input, allowInsecure = false) {
  const url = new URL(input);
  requireValue(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'Use a plain http(s) server origin without credentials or paths.');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  requireValue(url.protocol === 'https:' || local || allowInsecure, 'Remote workers require HTTPS. For a trusted private LAN only, explicitly pass --allow-insecure-lan.');
  return url.origin;
}
