import { existsSync, readFileSync, openSync, closeSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LIMITS, KINDS, secret, hash, matches, atomicJson, requireValue, validateJob } from './config.mjs';

export class FleetStore {
  constructor(directory, adminToken, { now = Date.now, lock = true } = {}) {
    this.path = join(directory, 'state.json');
    this.lockPath = join(directory, 'coordinator.lock');
    this.now = now;
    this.adminHash = hash(adminToken);
    this.locked = false;
    if (lock) this.acquireLock();
    try {
      this.data = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8'))
        : { version: 1, workers: [], jobs: [], pairings: [] };
      requireValue(this.data.version === 1 && ['workers', 'jobs', 'pairings'].every((key) => Array.isArray(this.data[key])), 'Unsupported or corrupt state file. Restore a backup.', 500);
      // A restart cannot know whether an in-flight operation completed. Never silently retry it.
      for (const job of this.data.jobs.filter((item) => item.status === 'running')) this.fail(job, 'Coordinator restarted; execution outcome is unknown. Submit a new job if safe.');
      this.save();
    } catch (error) { this.close(); throw error; }
  }
  acquireLock() {
    if (existsSync(this.lockPath)) {
      const pid = Number(readFileSync(this.lockPath, 'utf8'));
      let alive = true;
      try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) throw new Error('A coordinator already owns this state directory.');
      unlinkSync(this.lockPath);
    }
    const fd = openSync(this.lockPath, 'wx', 0o600);
    writeFileSync(fd, String(process.pid)); closeSync(fd); this.locked = true;
  }
  close() { if (this.locked) { unlinkSync(this.lockPath); this.locked = false; } }
  timestamp() { return new Date(this.now()).toISOString(); }
  save() { atomicJson(this.path, this.data); }
  admin(token) { return matches(token, this.adminHash); }
  worker(token) { return this.data.workers.find((worker) => !worker.revoked && matches(token, worker.tokenHash)); }
  fail(job, error) { job.status = 'failed'; job.error = error; job.updatedAt = this.timestamp(); delete job.leaseToken; }
  expire() {
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
      jobs: this.data.jobs.map(({ leaseToken, leaseUntil, deadline, ...job }) => job),
      limits: { maxJobs: LIMITS.maxJobs, textBytes: LIMITS.textBytes, jobTimeoutMs: LIMITS.jobTimeoutMs },
    };
  }
  pairing() {
    this.data.pairings = this.data.pairings.filter((item) => item.expiresAt > this.now());
    requireValue(this.data.pairings.length < LIMITS.maxPairings, 'Too many pending pairing codes. Wait for expiry.', 429);
    const code = secret();
    const expiresAt = this.now() + LIMITS.pairingMs;
    this.data.pairings.push({ hash: hash(code), expiresAt }); this.save();
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }
  enroll({ code, name, capabilities }) {
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
    const worker = this.data.workers.find((item) => item.id === id && !item.revoked);
    requireValue(worker, 'Worker not found.', 404);
    worker.revoked = true;
    for (const job of this.data.jobs.filter((item) => item.workerId === id && item.status === 'running')) this.fail(job, 'Worker revoked; execution outcome is unknown.');
    this.save(); return { revoked: true };
  }
  submit({ kind, payload }) {
    const clean = validateJob(kind, payload);
    requireValue(this.data.jobs.length < LIMITS.maxJobs, 'Job history is full. Delete completed jobs before submitting more.', 409);
    const job = { id: randomUUID(), kind, payload: clean, status: 'queued', createdAt: this.timestamp(), updatedAt: this.timestamp(), workerId: null };
    this.data.jobs.push(job); this.save(); return structuredClone(job);
  }
  cancel(id) {
    const job = this.data.jobs.find((item) => item.id === id);
    requireValue(job, 'Job not found.', 404);
    if (['queued', 'running'].includes(job.status)) { job.status = 'cancelled'; job.updatedAt = this.timestamp(); delete job.leaseToken; this.save(); }
    return { id, status: job.status };
  }
  clearCompleted() {
    const before = this.data.jobs.length;
    this.data.jobs = this.data.jobs.filter((job) => ['queued', 'running'].includes(job.status)); this.save();
    return { deleted: before - this.data.jobs.length };
  }
  claim(worker) {
    this.expire(); worker.lastSeen = this.timestamp();
    if (this.data.jobs.some((job) => job.workerId === worker.id && job.status === 'running')) { this.save(); return { job: null }; }
    const job = this.data.jobs.find((item) => item.status === 'queued' && worker.capabilities.includes(item.kind));
    if (!job) { this.save(); return { job: null }; }
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
    worker.lastSeen = this.timestamp(); job.leaseUntil = this.now() + LIMITS.leaseMs; this.save();
    return { active: true };
  }
  complete(worker, { id, leaseToken, result, error }) {
    const job = this.lease(worker, id, leaseToken);
    requireValue(typeof error === 'undefined' || (typeof error === 'string' && error.length <= 1000), 'Error must be a short string.');
    requireValue(typeof result !== 'undefined' || typeof error === 'string', 'Completion needs a result or error.');
    requireValue(Buffer.byteLength(JSON.stringify(result ?? null)) <= LIMITS.resultBytes, 'Result exceeds 512 KiB.');
    job.status = error ? 'failed' : 'completed';
    if (error) job.error = error; else job.result = result;
    job.updatedAt = this.timestamp(); worker.lastSeen = this.timestamp(); delete job.leaseToken; this.save();
    return { id: job.id, status: job.status };
  }
}
