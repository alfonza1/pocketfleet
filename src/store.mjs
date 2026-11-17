import { existsSync, openSync, closeSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LIMITS, KINDS, secret, hash, matches, atomicJson, requireValue, validateJob } from './config.mjs';
import { readFleetState } from './state-file.mjs';

export class FleetStore {
  constructor(directory, adminToken, { now = Date.now, lock = true, persist = atomicJson } = {}) {
    this.path = join(directory, 'state.json');
    this.lockPath = join(directory, 'coordinator.lock');
    this.now = now;
    this.persist = persist;
    this.persistenceFailed = false;
    this.lastDurable = null;
    this.adminHash = hash(adminToken);
    this.locked = false;
    if (lock) this.acquireLock();
    try {
      this.data = existsSync(this.path) ? readFleetState(this.path)
        : { version: 1, workers: [], jobs: [], pairings: [] };
      requireValue(this.data.version === 1 && ['workers', 'jobs', 'pairings'].every((key) => Array.isArray(this.data[key])), 'Unsupported or corrupt state file. Restore a backup.', 500);
      // A restart cannot know whether an in-flight operation completed. Never silently retry it.
      for (const job of this.data.jobs.filter((item) => item.status === 'running')) this.fail(job, 'Coordinator restarted; execution outcome is unknown. Submit a new job if safe.');
      this.save();
    } catch (error) { this.close(); throw error; }
  }
  acquireLock() {
    if (existsSync(this.lockPath)) {
      throw new Error('A coordinator already owns this state directory. If it crashed, confirm its PID in coordinator.lock has stopped, then remove that lock before restarting.');
    }
    const fd = openSync(this.lockPath, 'wx', 0o600);
    try { writeFileSync(fd, String(process.pid)); this.locked = true; }
    finally { closeSync(fd); if (!this.locked) unlinkSync(this.lockPath); }
  }
  close() { if (this.locked) { unlinkSync(this.lockPath); this.locked = false; } }
  timestamp() { return new Date(this.now()).toISOString(); }
  assertHealthy() { requireValue(!this.persistenceFailed, 'Persistence failed. Free disk space or fix permissions, then restart the coordinator. Dispatch is stopped.', 503); }
  rollback() {
    if (!this.lastDurable) return;
    const restored = JSON.parse(this.lastDurable);
    // Heartbeats are intentionally ephemeral. A rejected write must not rewind them.
    for (const job of restored.jobs) {
      const current = this.data.jobs.find((item) => item.id === job.id);
      if (job.status === 'running' && current?.workerId === job.workerId && current.deadline === job.deadline) {
        job.leaseUntil = Math.max(job.leaseUntil, current.leaseUntil);
      }
    }
    for (const worker of restored.workers) {
      const current = this.data.workers.find((item) => item.id === worker.id);
      if (current) worker.lastSeen = current.lastSeen;
    }
    this.data = restored;
  }
  save() {
    this.assertHealthy();
    const serialized = JSON.stringify(this.data);
    if (Buffer.byteLength(serialized) > LIMITS.stateBytes) {
      this.rollback();
      requireValue(false, 'Fleet state exceeds 16 MiB. Clear terminal jobs before continuing.', 409);
    }
    try { this.persist(this.path, this.data); this.lastDurable = serialized; }
    catch (error) {
      this.rollback();
      this.persistenceFailed = true;
      throw Object.assign(new Error('Could not persist state. Dispatch is stopped until the coordinator is restarted.'), { status: 503, cause: error });
    }
  }
  admin(token) { return matches(token, this.adminHash); }
  worker(token) { return this.data.workers.find((worker) => !worker.revoked && matches(token, worker.tokenHash)); }
  fail(job, error) { job.status = 'failed'; job.error = error; job.updatedAt = this.timestamp(); delete job.leaseToken; }
  expire() {
    this.assertHealthy();
    let changed = false;
    for (const job of this.data.jobs) {
      if (job.status === 'running' && (job.leaseUntil <= this.now() || job.deadline <= this.now())) {
        this.fail(job, job.deadline <= this.now() ? 'Job exceeded its execution deadline.' : 'Worker lease expired; execution outcome is unknown.'); changed = true;
      }
    }
    if (changed) this.save();
  }
  snapshot() {
    this.expire();
    return {
      workers: this.data.workers.filter((worker) => !worker.revoked).map(({ tokenHash, revoked, ...worker }) => ({
        ...worker, online: this.now() - Date.parse(worker.lastSeen) < LIMITS.offlineMs,
        busy: this.data.jobs.some((job) => job.workerId === worker.id && job.status === 'running'),
      })),
      jobs: this.data.jobs.map(({ leaseToken, leaseUntil, deadline, payload, result, completionReceipt, idempotencyKey, ...job }) => job),
      limits: { maxJobs: LIMITS.maxJobs, textBytes: LIMITS.textBytes, jobTimeoutMs: LIMITS.jobTimeoutMs },
    };
  }
  pairing() {
    this.assertHealthy();
    this.data.pairings = this.data.pairings.filter((item) => item.expiresAt > this.now());
    requireValue(this.data.pairings.length < LIMITS.maxPairings, 'Too many pending pairing codes. Wait for expiry.', 429);
    const code = secret();
    const expiresAt = this.now() + LIMITS.pairingMs;
    this.data.pairings.push({ hash: hash(code), expiresAt }); this.save();
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }
  enroll({ code, name, capabilities }) {
    this.assertHealthy();
    requireValue(typeof name === 'string' && name.trim().length > 0 && name.length <= 64, 'Worker name must be 1–64 characters.');
    requireValue(Array.isArray(capabilities) && capabilities.length > 0 && capabilities.length <= KINDS.length && capabilities.every((kind) => KINDS.includes(kind)), 'Unsupported capabilities.');
    const index = this.data.pairings.findIndex((item) => item.expiresAt > this.now() && matches(code, item.hash));
    requireValue(index !== -1, 'Pairing code is invalid, expired, or already used.', 401);
    requireValue(this.data.workers.filter((worker) => !worker.revoked).length < LIMITS.maxWorkers, 'Fleet is limited to 32 active workers.', 409);
    const token = secret();
    const worker = { id: randomUUID(), name: name.trim(), capabilities: [...new Set(capabilities)], lastSeen: this.timestamp(), tokenHash: hash(token), revoked: false };
    this.data.pairings.splice(index, 1); this.data.workers.push(worker); this.save();
    return { id: worker.id, token };
  }
  revoke(id) {
    this.assertHealthy();
    const worker = this.data.workers.find((item) => item.id === id && !item.revoked);
    requireValue(worker, 'Worker not found.', 404);
    this.data.workers = this.data.workers.filter((item) => item.id !== id);
    for (const job of this.data.jobs.filter((item) => item.workerId === id && item.status === 'running')) this.fail(job, 'Worker revoked; execution outcome is unknown.');
    this.save(); return { revoked: true };
  }
  submit({ kind, payload }, idempotencyKey) {
    this.assertHealthy();
    const clean = validateJob(kind, payload);
    if (idempotencyKey !== undefined) {
      requireValue(typeof idempotencyKey === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey), 'Idempotency-Key must be 1–128 letters, digits, dots, underscores, colons or hyphens.');
      const previous = this.data.jobs.find((job) => job.idempotencyKey === idempotencyKey);
      if (previous) {
        requireValue(previous.kind === kind && JSON.stringify(previous.payload) === JSON.stringify(clean), 'Idempotency-Key already belongs to a different job.', 409);
        return this.detail(previous.id);
      }
    }
    requireValue(this.data.jobs.length < LIMITS.maxJobs, 'Job history is full. Delete completed jobs before submitting more.', 409);
    const job = { id: randomUUID(), kind, payload: clean, status: 'queued', createdAt: this.timestamp(), updatedAt: this.timestamp(), workerId: null };
    if (idempotencyKey !== undefined) job.idempotencyKey = idempotencyKey;
    this.data.jobs.push(job); this.save(); return this.detail(job.id);
  }
  cancel(id) {
    this.assertHealthy();
    const job = this.data.jobs.find((item) => item.id === id);
    requireValue(job, 'Job not found.', 404);
    if (['queued', 'running'].includes(job.status)) { job.status = 'cancelled'; job.updatedAt = this.timestamp(); delete job.leaseToken; this.save(); }
    return { id, status: job.status };
  }
  clearCompleted() {
    this.assertHealthy();
    const before = this.data.jobs.length;
    this.data.jobs = this.data.jobs.filter((job) => ['queued', 'running'].includes(job.status)); this.save();
    return { deleted: before - this.data.jobs.length };
  }
  claim(worker) {
    this.expire(); worker.lastSeen = this.timestamp();
    if (this.data.jobs.some((job) => job.workerId === worker.id && job.status === 'running')) return { job: null };
    const job = this.data.jobs.find((item) => item.status === 'queued' && worker.capabilities.includes(item.kind));
    if (!job) return { job: null };
    Object.assign(job, { status: 'running', workerId: worker.id, updatedAt: this.timestamp(), leaseToken: secret(), leaseUntil: this.now() + LIMITS.leaseMs, deadline: this.now() + LIMITS.jobTimeoutMs });
    this.save(); return { job: structuredClone(job) };
  }
  lease(worker, id, leaseToken) {
    this.expire();
    const job = this.data.jobs.find((item) => item.id === id);
    requireValue(job && job.workerId === worker.id && job.status === 'running' && matches(leaseToken, hash(job.leaseToken ?? '')), 'Job lease is no longer active.', 409);
    return job;
  }
  heartbeat(worker, { id, leaseToken }) {
    const job = this.lease(worker, id, leaseToken);
    worker.lastSeen = this.timestamp(); job.leaseUntil = this.now() + LIMITS.leaseMs;
    return { active: true };
  }
  complete(worker, { id, leaseToken, result, error }) {
    this.assertHealthy();
    const existing = this.data.jobs.find((item) => item.id === id);
    const payloadHash = hash(JSON.stringify({ result, error }));
    if (existing?.completionReceipt && existing.workerId === worker.id && matches(leaseToken, existing.completionReceipt.tokenHash)) {
      requireValue(existing.completionReceipt.payloadHash === payloadHash, 'Job lease already completed with a different result.', 409);
      return { id: existing.id, status: existing.status };
    }
    const job = this.lease(worker, id, leaseToken);
    requireValue(typeof error === 'undefined' || (typeof error === 'string' && error.trim().length > 0 && error.length <= 1000), 'Error must be a nonempty short string.');
    requireValue((typeof result !== 'undefined') !== (typeof error === 'string'), 'Completion needs exactly one result or error.');
    requireValue(Buffer.byteLength(JSON.stringify(result ?? null)) <= LIMITS.resultBytes, 'Result exceeds 512 KiB.');
    job.status = error ? 'failed' : 'completed';
    if (error) job.error = error; else job.result = result;
    job.completionReceipt = { tokenHash: hash(leaseToken), payloadHash };
    job.updatedAt = this.timestamp(); worker.lastSeen = this.timestamp(); delete job.leaseToken; this.save();
    return { id: job.id, status: job.status };
  }
  detail(id) {
    this.expire();
    const found = this.data.jobs.find((job) => job.id === id);
    requireValue(found, 'Job not found.', 404);
    const { leaseToken, leaseUntil, deadline, completionReceipt, idempotencyKey, ...job } = found;
    return structuredClone(job);
  }
}
