import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const directories = ['src', 'scripts', 'test', 'public', 'site'];
let count = 0;
for (const directory of directories) {
  for (const name of readdirSync(directory)) {
    if (!/\.(mjs|js)$/.test(name)) continue;
    const result = spawnSync(process.execPath, ['--check', join(directory, name)], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1); count++;
  }
}
console.log(`Syntax checked ${count} JavaScript modules. No compilation required.`);
