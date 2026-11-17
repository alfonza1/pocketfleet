import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('one-shot demo verifies real worker output, exits, and leaves the workspace empty', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pocketfleet-first-run-'));
  try {
    const output = execFileSync(process.execPath, [
      fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), 'demo', '--once',
    ], {
      cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 30_000,
      env: { ...process.env, TMP: directory, TEMP: directory, TMPDIR: directory },
    });
    assert.match(output, /Text worker\s+43 words counted/);
    assert.match(output, /305 bytes compressed to \d+ bytes \(round-trip verified\)/);
    assert.doesNotMatch(output, /[0-9a-f]{64}/);
    assert.deepEqual(readdirSync(directory), []);
  } finally {
    rmdirSync(directory);
  }
});
