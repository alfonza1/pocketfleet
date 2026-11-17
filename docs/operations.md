# Operating and recovering a personal fleet

## Before upgrading

Use a local disk. While the old coordinator is running, save a backup if it supports
the backup endpoint. For a v0.1 upgrade, stop the coordinator and securely copy the
entire `.pocketfleet` directory first. Never run two coordinators against one directory.
v0.2 reads valid v0.1 state without an explicit migration. Invalid state is preserved
and startup refuses to dispatch it. Existing workers can reconnect with their credentials.
The public npm tarball is the supported packaged installation; source clones also work.

## Diagnose without exposing secrets

`pocketfleet doctor --dir PATH` checks configuration, bounded saved state and the lock PID.
It prints no tokens, payloads or results. Exit code 0 means these local checks passed;
1 means a check failed. It does not verify firewalls, remote TLS trust, model availability,
or that a live PID is definitely the coordinator. `/health` returns 503 after persistence
failure. Fix disk space/permissions before restarting; do not keep submitting work.

## Backup

`pocketfleet backup --dir PATH --server URL --file NEW.backup.json` requests an authenticated,
consistent snapshot. It publishes a fully written and flushed archive without overwriting
an existing file. Use a filesystem supporting hard links (such as NTFS, APFS or ext4);
unsupported archive destinations fail rather than fall back to a partial final file.
Use a local disk, then copy the completed archive to your backup destination.

Protect archives as private data. Keep the matching `config.json` in a separate secure
backup: archives contain its fingerprint, not the plaintext admin token. Verify an archive
by restoring a **copy** in a separate temporary state directory with a copy of config.json;
never test disaster recovery against the only live data. Do not run both copies as active
fleets or reuse recovered credentials across them.

## Restore

1. Stop the coordinator. Confirm its process exited. `restore` refuses an occupied lock.
2. Put its original `config.json` in the state directory if recovering onto a new machine.
3. Run `pocketfleet restore --dir PATH --file BACKUP.json`. To intentionally replace existing
   state, add `--replace`. The previous state is retained as `state.before-restore.UUID.json`.
4. Run `pocketfleet doctor --dir PATH`, then start the coordinator.
5. Re-pair workers using **new worker directories**. Restoring intentionally invalidates
   all old worker credentials and pairing codes, including credentials revoked since backup.
6. Review retained history. Previously queued/running jobs are failed, never replayed.
   Submit new jobs explicitly after deciding whether repeating their work is safe.

A corrupt backup or credential mismatch is rejected before changing the state. A failed
restore may leave the preserved prior-state file; keep it until recovery is verified.
No restore command deletes existing data directories or rotates credentials silently.

## Crashes and stale locks

After a crash, inspect the PID in `coordinator.lock` and use OS process tools to confirm
no coordinator still uses the directory before removing that **single lock file**. Never
automatically delete locks based only on elapsed time. PID reuse is possible. On restart,
in-flight jobs fail with unknown outcome; no automatic execution retry occurs.

## Network and worker failures

Workers pull from the coordinator and need no inbound worker port. Use TLS and a trusted
certificate for remote workers; `NODE_EXTRA_CA_CERTS` can supply your private CA before
launching Node. Do not disable verification. The insecure-LAN override is for a trusted
isolated network only. A CLI `--server` value must be a plain origin, not a credential URL.

Reconnects use exponential backoff with jitter, capped at 30 seconds. Authentication
failures stop the worker. Completion acknowledgement is retried at most three times,
without re-executing the job. A lost lease ends acceptance of its result. A disconnected
model server might continue computing even after the worker aborts its HTTP request.

## Retention and limitations

State is capped at 16 MiB/500 jobs; payloads at 128 KiB and results at 512 KiB. Clear terminal
history after backing up needed results. Clearing a job also removes its submission
idempotency key. One worker runs one job. Jobs have a two-minute deadline. Constants live
in `src/config.mjs`; changing them requires coordinated testing and restarts.

This remains a bounded, single-coordinator personal tool: no HA, arbitrary shell execution,
resource sandbox, cross-GPU model splitting, automatic discovery, or certified disaster
recovery. File data is fsynced; parent-directory fsync is POSIX-only. Keep independent
backups even on platforms where directory flush succeeds.
