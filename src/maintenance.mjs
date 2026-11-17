import { existsSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync, statSync, copyFileSync, constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readConfig, hash, LIMITS, atomicJson, requireValue } from './config.mjs';
import { readFleetState, validateFleetState } from './state-file.mjs';

export function writeBackup(path, backup) {
  validateBackup(backup);
  atomicJson(path, backup, { exclusive: true });
}

export function validateBackup(backup) {
  requireValue(backup?.format === 'pocketfleet-backup' && backup.version === 1 && /^[a-f0-9]{64}$/.test(backup.coordinatorHash), 'Invalid backup format.');
  requireValue(typeof backup.createdAt === 'string' && Number.isFinite(Date.parse(backup.createdAt)), 'Invalid backup timestamp.');
  validateFleetState(backup.state);
  return backup;
}

export function restoreBackup(directory, file, { replace = false } = {}) {
  const { adminToken } = readConfig(directory);
  requireValue(statSync(file).size <= LIMITS.stateBytes * 2, 'Backup exceeds the maximum size.');
  const backup = validateBackup(JSON.parse(readFileSync(file, 'utf8')));
  requireValue(backup.coordinatorHash === hash(adminToken), 'Backup belongs to different coordinator credentials. Restore its original config.json first.');
  const statePath = join(directory, 'state.json');
  requireValue(resolve(file) !== resolve(statePath), 'Choose a separate backup archive, not state.json.');
  requireValue(!existsSync(statePath) || replace, 'State already exists. Stop the coordinator and use --replace to restore explicitly.');
  const lockPath = join(directory, 'coordinator.lock');
  let descriptor;
  try { descriptor = openSync(lockPath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Stop the coordinator before restoring. Do not remove a live coordinator.lock.'); throw error; }
  let preserved;
  try {
    writeFileSync(descriptor, String(process.pid)); closeSync(descriptor); descriptor = undefined;
    requireValue(!existsSync(statePath) || replace, 'State appeared before the restore lock was acquired. Use --replace explicitly.');
    if (existsSync(statePath)) {
      preserved = join(directory, `state.before-restore.${randomUUID()}.json`);
      copyFileSync(statePath, preserved, constants.COPYFILE_EXCL);
    }
    const state = structuredClone(backup.state);
    // Old backups must never resurrect revoked credentials or replay historical work.
    state.workers = []; state.pairings = [];
    for (const job of state.jobs) {
      if (['queued', 'running'].includes(job.status)) {
        job.status = 'failed'; job.error = 'Restored backup; execution outcome is unknown. Submit a new job explicitly if safe.';
        job.updatedAt = new Date().toISOString(); delete job.leaseToken;
      }
    }
    validateFleetState(state); atomicJson(statePath, state);
    return { restoredJobs: state.jobs.length, workersRequirePairing: true, preserved: preserved ?? null };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    unlinkSync(lockPath);
  }
}

export function inspectDirectory(directory) {
  const report = { ok: true, directory: resolve(directory), checks: [] };
  const check = (name, fn) => {
    try { report.checks.push({ name, ok: true, detail: fn() }); }
    catch (error) { report.ok = false; report.checks.push({ name, ok: false, detail: error.message }); }
  };
  check('configuration', () => { readConfig(directory); return 'Valid credentials (not displayed).'; });
  check('state', () => {
    const path = join(directory, 'state.json');
    if (!existsSync(path)) return 'No queue yet; first startup creates it.';
    const state = readFleetState(path); return `${state.jobs.length} jobs; ${state.workers.length} workers; schema valid.`;
  });
  check('lock', () => {
    const path = join(directory, 'coordinator.lock');
    if (!existsSync(path)) return 'No coordinator lock.';
    const pid = Number(readFileSync(path, 'utf8'));
    requireValue(Number.isSafeInteger(pid) && pid > 0, 'Invalid lock PID; inspect before removing it.');
    try { process.kill(pid, 0); return `Process ${pid} exists. Confirm it is the coordinator before maintenance.`; }
    catch (error) { if (error.code === 'ESRCH') throw new Error(`Stale lock for PID ${pid}. Confirm no coordinator uses this directory before removing coordinator.lock.`); throw error; }
  });
  return report;
}
