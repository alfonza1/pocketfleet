import { readFileSync, statSync } from 'node:fs';
import { LIMITS, KINDS, requireValue, validateJob } from './config.mjs';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isId = (value) => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const isSecret = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isDate = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const isTime = (value) => Number.isSafeInteger(value) && value >= 0;
const valid = (condition) => requireValue(condition, 'Invalid fleet state. Original data was preserved; restore a verified backup.', 500);

function unique(items, key) {
  valid(new Set(items.map((item) => item[key])).size === items.length);
}

export function validateFleetState(data) {
  valid(isObject(data) && data.version === 1);
  for (const [key, cap] of [['workers', LIMITS.maxWorkers], ['jobs', LIMITS.maxJobs], ['pairings', LIMITS.maxPairings]]) {
    valid(Array.isArray(data[key]) && data[key].length <= cap && data[key].every(isObject));
  }
  valid(Buffer.byteLength(JSON.stringify(data)) <= LIMITS.stateBytes);
  unique(data.workers, 'id'); unique(data.jobs, 'id'); unique(data.pairings, 'hash');
  for (const worker of data.workers) {
    valid(isId(worker.id) && typeof worker.name === 'string' && worker.name.trim().length > 0 && worker.name.length <= 64);
    valid(isSecret(worker.tokenHash) && isDate(worker.lastSeen) && typeof worker.revoked === 'boolean');
    valid(Array.isArray(worker.capabilities) && worker.capabilities.length > 0 && worker.capabilities.length <= KINDS.length && worker.capabilities.every((kind) => KINDS.includes(kind)));
  }
  for (const pairing of data.pairings) valid(isSecret(pairing.hash) && isTime(pairing.expiresAt));
  const keys = new Set();
  for (const job of data.jobs) {
    valid(isId(job.id) && isDate(job.createdAt) && isDate(job.updatedAt));
    valid(['queued', 'running', 'completed', 'failed', 'cancelled'].includes(job.status));
    valid(job.workerId === null || isId(job.workerId));
    try { validateJob(job.kind, job.payload); } catch { valid(false); }
    if (job.status === 'running') valid(isId(job.workerId) && isSecret(job.leaseToken) && isTime(job.leaseUntil) && isTime(job.deadline));
    else valid(job.leaseToken === undefined);
    if (job.status === 'completed') valid(Object.hasOwn(job, 'result'));
    if (job.result !== undefined) valid(Buffer.byteLength(JSON.stringify(job.result)) <= LIMITS.resultBytes);
    if (job.error !== undefined) valid(typeof job.error === 'string' && job.error.length > 0 && job.error.length <= 1000);
    if (job.idempotencyKey !== undefined) {
      valid(typeof job.idempotencyKey === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(job.idempotencyKey) && !keys.has(job.idempotencyKey));
      keys.add(job.idempotencyKey);
    }
    if (job.completionReceipt !== undefined) {
      valid(['completed', 'failed'].includes(job.status) && isObject(job.completionReceipt));
      valid(isSecret(job.completionReceipt.tokenHash) && isSecret(job.completionReceipt.payloadHash));
    }
  }
  return data;
}

export function readFleetState(path) {
  // v0.1 used pretty JSON; allow its whitespace overhead before validating the content cap.
  valid(statSync(path).size <= LIMITS.stateBytes * 2);
  let data;
  try { data = JSON.parse(readFileSync(path, 'utf8')); } catch { valid(false); }
  return validateFleetState(data);
}
