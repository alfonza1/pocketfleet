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
  // Explicitly allowed HTTP LAN origins do not expose randomUUID.
  await page.addInitScript(() => Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true }));
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
  await expect(page.locator('.setup-help')).toContainText('node src/cli.mjs token');
  await expect(page.locator('.demo-help')).toContainText('pocketfleet demo');
  if (process.argv.includes('--screenshots')) await page.screenshot({ path: 'docs/screenshots/login.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  if (process.argv.includes('--screenshots')) await page.screenshot({ path: 'docs/screenshots/login-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login('invalid-test-token');
  await expect(page.locator('#notice')).toContainText('not accepted');
  await expect(page.locator('#login-panel')).toBeVisible();
  await login(adminToken);
  await expect(page.locator('#connection-label')).toHaveText('Fleet connected');
  await expect(page.locator('#jobs')).toContainText('Run your first job');
  await expect(page.locator('#clear-history')).toBeDisabled();
  await expect(page.locator('#workers')).toContainText('second terminal');
  if (process.argv.includes('--screenshots')) await page.screenshot({ path: 'docs/screenshots/desktop-empty.png', fullPage: true });
  await page.getByRole('button', { name: 'Prepare a gzip job' }).click();
  await expect(page.locator('#kind')).toHaveValue('gzip');
  await expect(page.locator('#payload')).toHaveValue(/returns a real gzip file/);
  await expect(page.locator('#payload')).toBeFocused();
  assert.equal((await state()).jobs.length, 0, 'Preparing an example must not dispatch work');
  await page.locator('#kind').selectOption('text-stats');

  await page.locator('#payload').fill('🌍'.repeat(40000));
  await expect(page.locator('#payload')).toHaveAttribute('aria-invalid', 'true');
  assert.equal(await page.locator('#payload').evaluate((input) => input.checkValidity()), false);
  await page.locator('#payload').fill('Valid text');
  await expect(page.locator('#payload')).toHaveAttribute('aria-invalid', 'false');

  const first = await enroll('Desktop · browser check');
  const second = await enroll('Laptop · browser check');
  await page.locator('#close-pair').click();
  await expect(page.locator('#workers .worker')).toHaveCount(2, { timeout: 10000 });

  // Simulate a response lost after the coordinator durably accepts the job.
  const submissionKeys = [];
  await page.route('**/api/jobs', async (route) => {
    submissionKeys.push(route.request().headers()['idempotency-key']);
    if (submissionKeys.length === 1) { await route.fetch(); await route.abort(); }
    else await route.continue();
  });
  await page.locator('#payload').fill('Hello hello\nworld');
  await page.locator('#job-form').evaluate((form) => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await expect(page.locator('#notice')).toContainText('Cannot reach');
  assert.equal(submissionKeys.length, 1, 'Concurrent submits must issue only one request');
  const textJob = await requestFromUI('/api/jobs', 'POST', () => page.locator('#submit-job').click());
  await page.unroute('**/api/jobs');
  assert.ok(submissionKeys[0] && submissionKeys[0] === submissionKeys[1], 'Retry must reuse its submission key');
  assert.equal((await state()).jobs.length, 1, 'Lost-response retry must not create another job');
  assert.equal(await processOne({ server, token: first.token }), true);
  await expect(row(textJob.id).locator('.status')).toHaveText('completed', { timeout: 10000 });
  await row(textJob.id).getByRole('button', { name: 'Inspect' }).click();
  await expect(page.locator('#result-output')).toContainText('"words"');
  const stats = JSON.parse(await page.locator('#result-output').textContent());
  assert.equal(stats.words, 3);
  // Polling replaces job rows while a dialog is open; Escape must focus the new trigger.
  await page.waitForResponse((response) => new URL(response.url()).pathname === '/api/state');
  await page.keyboard.press('Escape');
  await expect(row(textJob.id).getByRole('button', { name: 'Inspect' })).toBeFocused();

  await page.route(`**/api/jobs/${textJob.id}`, (route) => route.abort());
  await row(textJob.id).getByRole('button', { name: 'Inspect' }).click();
  await expect(page.locator('#result-error')).toContainText('Cannot reach');
  await expect(page.locator('#download-result')).toBeHidden();
  await page.keyboard.press('Escape');
  await page.unroute(`**/api/jobs/${textJob.id}`);

  const untrustedOutput = `<img src=x onerror="alert('unsafe')">${'long worker output '.repeat(2200)}`;
  await page.route(`**/api/jobs/${textJob.id}`, async (route) => {
    const response = await route.fetch();
    const detail = await response.json();
    await route.fulfill({ response, json: { ...detail, result: { message: untrustedOutput } } });
  });
  await row(textJob.id).getByRole('button', { name: 'Inspect' }).click();
  await expect(page.locator('#result-output')).toContainText('Preview truncated');
  await expect(page.locator('#result-output img')).toHaveCount(0);
  const jsonDownloadPromise = page.waitForEvent('download');
  await page.locator('#download-result').click();
  const jsonDownload = await jsonDownloadPromise;
  assert.equal(JSON.parse(await readFile(await jsonDownload.path(), 'utf8')).message, untrustedOutput);
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (process.argv.includes('--screenshots')) await page.screenshot({ path: `docs/screenshots/result-${width}.png` });
  }
  await page.keyboard.press('Escape');
  await page.unroute(`**/api/jobs/${textJob.id}`);

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

  await page.context().setOffline(true);
  await expect(page.locator('#connection-label')).toHaveText('Connection interrupted', { timeout: 10000 });
  await page.context().setOffline(false);
  await expect(page.locator('#connection-label')).toHaveText('Fleet connected', { timeout: 10000 });
  await expect(page.locator('#notice')).toContainText('Connection restored');

  // A mutation's 401 must immediately end the session, without waiting for a poll.
  await page.route('**/api/pairing', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Admin authentication required."}' }));
  await page.locator('#pair').click();
  await expect(page.locator('#login-panel')).toBeVisible();
  await expect(page.locator('#notice')).toContainText('not accepted');
  await page.unroute('**/api/pairing');
  await login(adminToken);
  await expect(page.locator('#connection-label')).toHaveText('Fleet connected');
  const pairingAccepted = Promise.withResolvers();
  const releasePairing = Promise.withResolvers();
  const pairingFinished = Promise.withResolvers();
  await page.route('**/api/pairing', async (route) => {
    const response = await route.fetch();
    pairingAccepted.resolve();
    await releasePairing.promise;
    await route.fulfill({ response });
    pairingFinished.resolve();
  });
  await page.locator('#pair').click();
  await pairingAccepted.promise;
  const abortedPairing = page.waitForEvent('requestfailed', (request) => new URL(request.url()).pathname === '/api/pairing');
  await page.locator('#logout').click();
  await abortedPairing;
  releasePairing.resolve();
  await pairingFinished.promise;
  await page.unroute('**/api/pairing');
  await expect(page.locator('#login-panel')).toBeVisible();
  await expect(page.locator('#pair-command')).toHaveText('');
  await expect(page.locator('#notice')).toContainText('Disconnected');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('pocketfleet-token')), null);
  assert.deepEqual(errors, []);
  console.log('Browser check passed: auth, UTF-8 limits, duplicate/lost-response submission, two real workers, text analysis, gzip/JSON downloads, untrusted long output, dialog keyboard focus/error recovery, cancellation, filters, revocation, clear history, offline recovery, mutation auth expiry, pending-request logout, desktop and mobile.');
} finally {
  await browser?.close();
  await coordinator?.close();
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith('pocketfleet-browser-'));
  await rm(directory, { recursive: true, force: true });
}
