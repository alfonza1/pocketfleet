# Verification evidence

Initial release verified on Windows 11, Node 24.18.1. CI additionally runs the core
suite on Linux, macOS and Windows with Node 22 and 24; see the actual workflow results
for those environments rather than inferring them from this local record.

## Core and protocol

`npm test` runs 18 tests, including two independently authenticated HTTP workers
claiming distinct jobs, real gzip decompression, worker/admin separation, one-use and
expired pairing, cancellation/late completion, revocation, lease and absolute deadlines,
coordinator restart, single-writer lock, payload limits, secret-free summaries, state-size
cap, failure rollback, and no repeated disk writes on idle polling/heartbeats.
The TLS test creates an ephemeral certificate, rejects it without trust, and completes
an authenticated worker job when that certificate is explicitly trusted. OpenSSL is
required for this test (Git for Windows includes it).

`npm run lint` and `npm run build` syntax-check native modules. This JavaScript project
does not claim TypeScript checks. `npm pack --dry-run` reviews the distributable allowlist.
The public release tarball was downloaded, SHA-256 matched against the local artifact,
and installed into an empty prefix. The installed package served its dashboard and
completed a real paired-worker job. Installation directly from the public asset URL
also passed. A GitHub shorthand/tag install produced incomplete extraction on this
Windows/npm environment, so the README uses the verified release asset instead.

## Browser

Install development dependencies and the browser:

```powershell
npm ci
npx playwright install chromium
npm run test:e2e
```

The browser check creates temporary coordinator state, uses real API workers, and removes
its state afterward. It covers login, worker pairing, submit/completion, result inspection,
artifact download, cancellation, revocation and history clearing. Inspect desktop and
mobile screenshots under `docs/screenshots/`; they show actual executions, not fabricated
fleet metrics. Screenshots label the enrolled test workers as browser tests.

## Actual local-model execution

On November 17, 2026 a paired Ollama-capable worker submitted a real request to the
existing loopback Ollama service using the already installed
`qwen3.8-27b-opencode:Q4_K_M` model. The requested one-word response was `READY`, and
the completed job returned `READY` in approximately 34 seconds of model-server time.
No model was downloaded. The model loaded for this check was released afterward.
This validates one real integration, not broad model performance or a benchmark.

## Limits of this evidence

Two workers were exercised as separate clients/processes on this workstation. No second
physical computer was available for an end-to-end LAN test. HTTPS transport and trust
validation are covered separately; network/firewall setup depends on the user's machines.
Optional Ollama availability is not required for CI (its automated protocol test uses a
labelled HTTP fixture). No security audit or performance certification is claimed.
