# Changelog

## 0.2.0

- Durable file flushes, strict state validation, and private online backups with safe offline restore.
- Submission idempotency keys and completion acknowledgements that survive lost responses and restart.
- Worker reconnect backoff and per-identity rate limits for fleets behind one IP.
- Read-only doctor command; restore preserves old state and prevents replay or credential resurrection.
- Immediate auth-expiry handling, cancelled stale UI requests, UTF-8 input limits, and safe JSON result export.
- Expanded recovery, malformed-data, backup failure, concurrency and browser regression coverage.

## 0.1.0

- Initial local coordinator and browser dashboard.
- Single-use pairing, revocable worker credentials and capability-based pull dispatch.
- Text statistics, SHA-256, gzip artifact return, and optional local Ollama inference.
- Persisted queue, bounded leases, cancellation and explicit interrupted-job handling.
- Cross-platform CLI, protocol tests, browser verification and static documentation site.
