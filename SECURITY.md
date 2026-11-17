# Security

PocketFleet 0.1 is intended for trusted personal machines on loopback or a private
network. It is not a multi-tenant compute service and must not be publicly exposed.

Use HTTPS for remote workers. HTTP opt-in is only for isolated trusted LANs. Never
disable certificate verification. Keep admin credentials separate from worker credentials.
Revoke a lost worker in the dashboard. The app does not alter firewall rules.

Local configuration contains plaintext credentials, and state includes task inputs and
outputs. Files request owner-only permissions on POSIX; on Windows, rely on the user
profile's ACL and secure the chosen directory. Do not use a shared folder. Backups also
contain sensitive data. If an admin token is exposed, stop the coordinator and replace
the token in config.json with a fresh 64-character cryptographic hex secret, then restart.

Do not submit secrets in public issues. Use the repository's private vulnerability
reporting feature when available; otherwise contact the maintainer through their GitHub
profile without disclosing exploit details publicly. Include affected version, reproducible
conditions and impact, with tokens and user data removed.

Known boundary: paired workers can return incorrect output, and cancellation cannot
guarantee that a disconnected worker/model stopped computation. The default adapters
do not execute shell commands or access arbitrary local files.
