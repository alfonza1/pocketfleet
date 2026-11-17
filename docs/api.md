# HTTP API

All API bodies use JSON. Admin calls use `Authorization: Bearer <admin token>`.
Worker calls use their distinct worker token. Never expose the admin token to a worker.

| Method | Path | Role | Body / response |
| --- | --- | --- | --- |
| GET | `/health` | Public | `{ok, version}` |
| GET | `/api/state` | Admin | `{workers, jobs, limits}`; job summaries omit payloads/results and all credential/lease secrets |
| GET | `/api/jobs/:id` | Admin | Full job payload and result, without lease secrets |
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
Errors have `{error: "human-readable message"}` with 400/401/403/404/409/413/415/429/500.
Clients must not automatically retry ambiguous job submissions. There is no idempotency
key in v0.1; reconcile against `/api/state` after losing a submission response.
