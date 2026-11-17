# HTTP API

All API bodies use JSON. Admin calls use `Authorization: Bearer <admin token>`.
Worker calls use their distinct worker token. Never expose the admin token to a worker.

| Method | Path | Role | Body / response |
| --- | --- | --- | --- |
| GET | `/health` | Public | `{ok, version}` |
| GET | `/api/state` | Admin | `{workers, jobs, limits}`; job summaries omit payloads/results and all credential/lease secrets |
| GET | `/api/jobs/:id` | Admin | Full job payload and result, without lease secrets |
| GET | `/api/backup` | Admin | Consistent archive of private state, with credential fingerprint; no plaintext admin/worker credentials |
| POST | `/api/pairing` | Admin | `{code, expiresAt}` |
| POST | `/api/enroll` | Pairing code | `{code,name,capabilities}` → `{id,token}` |
| DELETE | `/api/workers/:id` | Admin | Revokes worker and fails its running jobs |
| POST | `/api/jobs` | Admin | `{kind,payload}` → queued job |
| POST | `/api/jobs/:id/cancel` | Admin | Idempotent cancellation; terminal states stay unchanged |
| DELETE | `/api/jobs/completed` | Admin | Deletes completed, failed and cancelled jobs; keeps active jobs |
| POST | `/api/worker/claim` | Worker | `{job}` or `{job:null}` |
| POST | `/api/worker/heartbeat` | Worker | `{id,leaseToken}` |
| POST | `/api/worker/complete` | Worker | `{id,leaseToken,result}` or `{id,leaseToken,error}` |

For `sha256`, `gzip`, and `text-stats`, use `payload: {text: "..."}`.
For `ollama`, use `payload: {model: "installed-model", prompt: "..."}`.
Unknown fields, unknown adapters, and oversized inputs are rejected. Empty text is valid;
empty model prompts are not. A job can remain queued until a compatible worker joins.

Worker responses are authenticated but otherwise trusted, not independently verified.
Errors have `{error: "human-readable message"}` with 400/401/403/404/409/413/415/429/500/503.

`POST /api/jobs` accepts an optional `Idempotency-Key` header: 1–128 ASCII letters,
digits, dots, underscores, colons or hyphens. Retrying the same kind/payload/key returns
the original job, including its terminal status. Reusing a key for different work returns
409. Keys persist across restarts but are removed when their job is cleared from history;
this is bounded deduplication, not an eternal exactly-once guarantee. Without a key,
reconcile against `/api/state` after losing a response rather than blindly resubmitting.

Workers may repeat an identical completion with its original lease after an acknowledgement
is lost. The stored receipt returns success without changing the completed result; an altered
result returns 409. Worker credentials must still be valid. The bundled worker makes at most
three completion attempts, never retries authentication failures, and uses jittered exponential
backoff capped at 30 seconds while reconnecting.

Rate limits are per authenticated worker/admin identity (600 requests/minute), not shared by
every worker behind one IP. Unauthenticated traffic is limited to 120 requests/minute/IP.
