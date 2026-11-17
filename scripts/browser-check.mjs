import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { chromium, expect } from '@playwright/test';
import { initialize } from '../src/config.mjs';
import { createCoordinator } from '../src/server.mjs';
import { api, enrollWorker, processOne } from '../src/worker.mjs';

const directory = await mkdtemp(join(tmpdir(), 'pocketfleet-browser-'));
const { adminToken } = initialize(directory);
let coordinator;
let browser;
try {
  coordinator = createCoordinator({ directory, adminToken });
  const address = await coordinator.listen(0);
  const server = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  const state = () => api(server, '/api/state', { token: adminToken, method: 'GET' });
  async function requestFromUI(path, method, action) {
    const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === path && response.request().method() === method);
    await action();
    const response = await responsePromise;
    assert.ok(response.ok(), `${method} ${path} failed (${response.status()})`);
    return response.json();
  }
  async function login(value) {
    await page.locator('#token').fill(value);
    await page.locator('#login-form button').click();
  }
  async function enroll(name) {
    const pairing = await requestFromUI('/api/pairing', 'POST', () => page.locator('#pair').click());
    const command = await page.locator('#pair-command').textContent();
    // Avoid logging the single-use code through an assertion failure.
    assert.ok(command.includes(`--code ${pairing.code}`), 'Pair command must contain its enrollment code');
    return enrollWorker({ server, code: pairing.code, name });
  }
  async function submit(kind, text) {
    await page.locator('#kind').selectOption(kind);
    await page.locator('#payload').fill(text);
    return requestFromUI('/api/jobs', 'POST', () => page.locator('#submit-job').click());
  }
  const row = (id) => page.locator('.job').filter({ has: page.locator(`[data-id="${id}"]`) });

  await page.goto(server);
  await expect(page.locator('#login-panel')).toBeVisible();
  await login('invalid-test-token');
  await expect(page.locator('#notice')).toContainText('not accepted');
  await expect(page.locator('#login-panel')).toBeVisible();
  await login(adminToken);
  await expect(page.locator('#connection-label')).toHaveText('Fleet connected');
  await expect(page.locator('#jobs')).toContainText('Nothing in the queue');
  await expect(page.locator('#clear-history')).toBeDisabled();

  const first = await enroll('Desktop · browser check');
  const second = await enroll('Laptop · browser check');
  await page.locator('#close-pair').click();
  await expect(page.locator('#workers .worker')).toHaveCount(2, { timeout: 10000 });

  const textJob = await submit('text-stats', 'Hello hello\nworld');
  assert.equal(await processOne({ server, token: first.token }), true);
  await expect(row(textJob.id).locator('.status')).toHaveText('completed', { timeout: 10000 });
  await row(textJob.id).getByRole('button', { name: 'Inspect' }).click();
  await expect(page.locator('#result-output')).toContainText('"words"');
  const stats = JSON.parse(await page.locator('#result-output').textContent());
  assert.equal(stats.words, 3);
  await page.locator('#close-result').click();

  const original = 'PocketFleet browser download check. 🌍';
  const gzipJob = await submit('gzip', original);
  assert.equal(await processOne({ server, token: second.token }), true);
  await expect(row(gzipJob.id).locator('.status')).toHaveText('completed', { timeout: 10000 });
  await row(gzipJob.id).getByRole('button', { name: 'Inspect' }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#download-result').click();
  const download = await downloadPromise;
  assert.equal(gunzipSync(await readFile(await download.path())).toString(), original);
  await page.locator('#close-result').click();

  const pending = await submit('ollama', 'This job should wait for an opted-in worker.');
  await expect(row(pending.id).locator('.status')).toHaveText('queued');
  await requestFromUI(`/api/jobs/${pending.id}/cancel`, 'POST', () => row(pending.id).getByRole('button', { name: 'Cancel', exact: true }).click());
  await expect(row(pending.id).locator('.status')).toHaveText('cancelled');
  const jobs = (await state()).jobs;
  assert.equal(new Set(jobs.filter((job) => job.status === 'completed').map((job) => job.workerId)).size, 2);

  await page.locator('#job-filter').selectOption('completed');
  await expect(page.locator('#jobs .job')).toHaveCount(2);
  await page.locator('#job-filter').selectOption('all');
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 1000 }]) {
    await page.setViewportSize(viewport);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Dashboard must not overflow horizontally');
    if (process.argv.includes('--screenshots')) {
      await page.screenshot({ path: `docs/screenshots/${viewport.width === 390 ? 'mobile' : 'desktop'}.png`, fullPage: true });
    }
  }

  await requestFromUI(`/api/workers/${second.id}`, 'DELETE', () => page.locator(`[data-action="revoke"][data-id="${second.id}"]`).click());
  await expect(page.locator('#workers .worker')).toHaveCount(1);
  await assert.rejects(api(server, '/api/worker/claim', { token: second.token }), /authentication/);
  await requestFromUI('/api/jobs/completed', 'DELETE', () => page.locator('#clear-history').click());
  await expect(page.locator('#jobs .job')).toHaveCount(0);
  await expect(page.locator('#clear-history')).toBeDisabled();
  await page.locator('#logout').click();
  await expect(page.locator('#login-panel')).toBeVisible();
  assert.equal(await page.evaluate(() => sessionStorage.getItem('pocketfleet-token')), null);
  assert.deepEqual(errors, []);
  console.log('Browser check passed: auth, two real workers, text analysis, gzip download, queued cancellation, filters, revocation, clear history, logout, desktop and mobile.');
} finally {
  await browser?.close();
  await coordinator?.close();
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith('pocketfleet-browser-'));
  await rm(directory, { recursive: true, force: true });
}
