#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { hostname } from 'node:os';
import { initialize, readConfig, atomicJson, requireValue, validateServer } from './config.mjs';
import { createCoordinator } from './server.mjs';
import { enrollWorker, runWorker, api } from './worker.mjs';
import { inspectDirectory, restoreBackup, writeBackup } from './maintenance.mjs';

const HELP = `PocketFleet 0.2.0 — a private fleet for the computers you already own

  pocketfleet init                         Create local credentials (.pocketfleet)
  pocketfleet serve [--init]               Start coordinator and dashboard :4320
  pocketfleet token                       Display your local admin token
  pocketfleet worker --server URL --code CODE [--name NAME]
  pocketfleet worker --server URL          Reconnect a previously paired worker
  pocketfleet submit --kind text-stats --text "hello fleet"
  pocketfleet submit --kind gzip --file input.txt
  pocketfleet status                      Show real workers and jobs as JSON
  pocketfleet pair                        Create a one-use worker pairing code
  pocketfleet doctor                      Inspect local configuration, queue and lock safely
  pocketfleet backup --file BACKUP.json    Save a consistent backup from a running coordinator
  pocketfleet restore --file BACKUP.json   Restore offline (existing state requires --replace)

Options: --dir PATH (state directory), --host IP, --port NUMBER,
  --cert PATH --key PATH (HTTPS), --allow-insecure-lan (trusted private LAN only),
  --ollama http://127.0.0.1:11434 (worker opt-in), --model NAME (submit),
  --idempotency-key KEY (submit retry protection while job remains in history).
Requires Node.js 22.12+. No shell execution, cloud service or model downloads.
For API clients use POCKETFLEET_TOKEN; never put admin credentials in a URL.
`;
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    dir: { type: 'string', default: '.pocketfleet' }, host: { type: 'string', default: '127.0.0.1' }, port: { type: 'string', default: '4320' },
    server: { type: 'string', default: 'http://127.0.0.1:4320' }, code: { type: 'string' }, name: { type: 'string', default: hostname() },
    cert: { type: 'string' }, key: { type: 'string' }, ollama: { type: 'string' }, kind: { type: 'string' }, text: { type: 'string' }, file: { type: 'string' }, model: { type: 'string' }, 'idempotency-key': { type: 'string' },
    replace: { type: 'boolean' },
    init: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, 'allow-insecure-lan': { type: 'boolean' },
  } });
  const command = positionals[0];
  if (values.help || !command) { console.log(HELP); return; }
  const directory = resolve(values.dir);
  if (command === 'init') { initialize(directory); console.log(`Initialized ${directory}. Run pocketfleet token to copy your admin token, then pocketfleet serve.`); return; }
  if (command === 'token') { console.log(readConfig(directory).adminToken); return; }
  if (command === 'doctor') {
    const report = inspectDirectory(directory); console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (command === 'restore') {
    requireValue(values.file, 'Provide --file BACKUP.json.');
    console.log(JSON.stringify(restoreBackup(directory, resolve(values.file), { replace: values.replace }), null, 2)); return;
  }
  if (command === 'serve') {
    const config = values.init ? initialize(directory) : readConfig(directory);
    const port = Number(values.port); requireValue(Number.isInteger(port) && port >= 1 && port <= 65535, 'Port must be 1–65535.');
    requireValue(Boolean(values.cert) === Boolean(values.key), 'Supply both --cert and --key.');
    const tls = values.cert ? { cert: readFileSync(values.cert), key: readFileSync(values.key) } : undefined;
    const coordinator = createCoordinator({ directory, adminToken: config.adminToken, host: values.host, tls, allowInsecure: values['allow-insecure-lan'] });
    try { await coordinator.listen(port); } catch (error) { coordinator.store.close(); throw error; }
    console.log(`PocketFleet listening on ${tls ? 'https' : 'http'}://${values.host}:${port}. Use pocketfleet token to sign in.`);
    const shutdown = () => coordinator.close().then(() => process.exit(0));
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown); return;
  }
  const server = validateServer(values.server, values['allow-insecure-lan']);
  if (command === 'worker') {
    if (values.ollama) {
      const url = new URL(values.ollama);
      requireValue(['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'Ollama must be a loopback http(s) origin.');
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const credentialPath = join(directory, 'worker.json');
    requireValue(!values.code || !existsSync(credentialPath), 'Worker credentials already exist here. Use a different --dir for a new worker.');
    const credentials = values.code
      ? await enrollWorker({ server, code: values.code, name: values.name, ollama: values.ollama, allowInsecure: values['allow-insecure-lan'] })
      : JSON.parse(readFileSync(credentialPath, 'utf8'));
    requireValue(credentials.server === server, 'Stored worker belongs to another coordinator. Choose a different --dir.');
    requireValue(credentials.capabilities.includes('ollama') === Boolean(values.ollama), 'Reconnect with the same --ollama setting, or pair a new worker.');
    if (values.code) atomicJson(credentialPath, credentials);
    console.log(`Worker ${credentials.id} connected (${credentials.capabilities.join(', ')}).`);
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort());
    await runWorker({ server, token: credentials.token, ollama: values.ollama, signal: controller.signal, onError: (error) => console.error(`Worker reconnecting: ${error.message}`) }); return;
  }
  const token = process.env.POCKETFLEET_TOKEN || readConfig(directory).adminToken;
  if (command === 'backup') {
    requireValue(values.file, 'Provide --file BACKUP.json (a new file).');
    const backup = await api(server, '/api/backup', { token, method: 'GET' });
    writeBackup(resolve(values.file), backup);
    console.log('Backup saved. It contains private job data. Keep config.json separately; restore requires the same coordinator credentials.');
  }
  else if (command === 'status') console.log(JSON.stringify(await api(server, '/api/state', { token, method: 'GET' }), null, 2));
  else if (command === 'pair') console.log(JSON.stringify(await api(server, '/api/pairing', { token }), null, 2));
  else if (command === 'submit') {
    requireValue(Boolean(values.file) !== (values.text !== undefined), 'Provide exactly one of --text or --file.');
    const text = values.file ? readFileSync(values.file, 'utf8') : values.text;
    const payload = values.kind === 'ollama' ? { prompt: text, model: values.model } : { text };
    console.log(JSON.stringify(await api(server, '/api/jobs', { token, body: { kind: values.kind, payload }, idempotencyKey: values['idempotency-key'] }), null, 2));
  } else throw new Error(`Unknown command: ${command}. Run pocketfleet --help.`);
}
main().catch((error) => { console.error(`PocketFleet: ${error.code === 'ENOENT' ? 'File not found. Run pocketfleet init first, and check supplied paths.' : error.message}`); process.exitCode = 1; });
