# Contributing

Start with a focused issue describing a real fleet workload, platform problem, or
onboarding difficulty. Reproduce problems without credentials or proprietary task data.

1. Fork and create a feature branch.
2. Use Node 22.12+ and run `npm ci`.
3. Keep adapters small and payloads explicitly validated.
4. Run `npm test`, `npm run lint`, and `npm run build`.
5. For UI changes, inspect the real dashboard at desktop and mobile widths.
6. Explain behavior, limitations, and validation in the pull request.

Useful contributions: bounded image/media adapters, additional platform test evidence,
accessible interaction improvements, and better worker diagnostics. Discuss sandboxing,
automatic retries, remote discovery, or execution of arbitrary code before implementing.
Never include `.pocketfleet`, tokens, certificate keys, generated archives, or task payloads
in a contribution. License contributions under MIT.
