'use strict';

const $ = (id) => document.getElementById(id);
const POLL_INTERVAL_MS = 3000;
const REQUEST_TIMEOUT_MS = 10000;
const MAX_TEXT_BYTES = 128 * 1024;
const PREVIEW_CHARACTERS = 30000;
const labels = { 'text-stats': 'Text analysis', sha256: 'SHA-256 hash', gzip: 'Gzip compression', ollama: 'Local model' };
const descriptions = {
  'text-stats': 'Count words, characters, and lines on an available worker.',
  sha256: 'Generate a SHA-256 digest of UTF-8 text on a worker.',
  gzip: 'Compress UTF-8 text and download the returned .gz artifact.',
  ollama: 'Send a prompt to a worker with Ollama explicitly enabled. Model inference stays on that worker.',
};
let token = '';
let fleet = { workers: [], jobs: [] };
let pollTimer;
let refreshing = false;
let selectedJob = null;
let generation = 0;
let connectionInterrupted = false;
let detailSequence = 0;
let inspectedJobId = null;
let submitting = false;
let submissionIntent = null;
let sessionController = new AbortController();
try { token = sessionStorage.getItem('pocketfleet-token') || ''; } catch { /* A private browser can disable storage. */ }

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}

function announce(message, error = false) {
  $('notice').textContent = message;
  $('notice').className = error ? 'notice error' : 'notice';
  $('notice').hidden = !message;
}

function connection(label, connected = false) {
  $('connection-label').textContent = label;
  $('connection-dot').className = connected ? 'dot connected' : 'dot warning';
}

async function api(path, options = {}) {
  const requestGeneration = generation;
  let response;
  try { response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...options.headers },
    signal: AbortSignal.any([sessionController.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
  }); } catch (error) {
    if (requestGeneration !== generation) error.handled = true;
    throw error;
  }
  let body;
  try { body = await response.json(); }
  catch (error) {
    if (requestGeneration !== generation) error.handled = true;
    if (response.ok) throw error;
    body = {};
  }
  if (requestGeneration !== generation) throw Object.assign(new Error('Session changed.'), { handled: true });
  if (!response.ok) {
    const error = new Error(typeof body.error === 'string' ? body.error : `Request failed (${response.status}).`);
    error.status = response.status;
    if (response.status === 401) {
      disconnect();
      announce('The admin token was not accepted. Copy the current token from your coordinator and reconnect.', true);
      error.handled = true;
    }
    throw error;
  }
  return body;
}

function reportError(error) {
  if (!error.handled) announce(readableError(error), true);
}

function newSubmissionKey() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function readableError(error) {
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'The coordinator did not respond in time. Check that it is running, then try again.';
  if (error instanceof TypeError) return 'Cannot reach the coordinator. Check the connection and try again.';
  return error.message || 'The request could not be completed.';
}

function setSession(value) {
  generation += 1;
  sessionController.abort();
  sessionController = new AbortController();
  token = value;
  try {
    if (value) sessionStorage.setItem('pocketfleet-token', value);
    else sessionStorage.removeItem('pocketfleet-token');
  } catch { /* The token can remain in memory for this page. */ }
  $('workspace').hidden = !value;
  $('login-panel').hidden = !!value;
  $('logout').hidden = !value;
  clearTimeout(pollTimer);
}

function disconnect() {
  setSession('');
  fleet = { workers: [], jobs: [] };
  selectedJob = null;
  submissionIntent = null;
  $('token').value = '';
  $('pairing').hidden = true;
  $('pair-command').textContent = '';
  $('result-dialog').close();
  $('result-output').textContent = '';
  $('workers').replaceChildren();
  $('jobs').replaceChildren();
  connection('Not connected');
  connectionInterrupted = false;
  $('token').focus();
}

async function refresh() {
  if (!token || refreshing) return;
  refreshing = true;
  const requestGeneration = generation;
  try {
    const data = await api('/api/state');
    if (requestGeneration !== generation) return;
    fleet = { workers: Array.isArray(data.workers) ? data.workers : [], jobs: Array.isArray(data.jobs) ? data.jobs : [] };
    if (connectionInterrupted) { announce('Connection restored. Fleet status is current.'); connectionInterrupted = false; }
    render();
    connection('Fleet connected', true);
    $('updated').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  } catch (error) {
    if (requestGeneration !== generation) return;
    if (!error.handled) {
      connection('Connection interrupted');
      connectionInterrupted = true;
      announce(readableError(error), true);
    }
  } finally {
    refreshing = false;
    if (token) pollTimer = setTimeout(refresh, POLL_INTERVAL_MS);
  }
}

function emptyState(title, description, icon = '▦') {
  const element = node('div', 'empty');
  element.append(node('span', 'empty-icon', icon), node('strong', '', title), node('span', '', description));
  return element;
}

function preserveFocus(container, renderContents) {
  const focusKey = container.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
  renderContents();
  if (focusKey) [...container.querySelectorAll('[data-focus]')].find((element) => element.dataset.focus === focusKey)?.focus({ preventScroll: true });
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown time' : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function actionButton(label, action, id, className = 'text-button') {
  const button = node('button', className, label);
  button.type = 'button';
  button.dataset.action = action;
  button.dataset.id = id;
  button.dataset.focus = `${action}-${id}`;
  return button;
}

function renderWorkers() {
  const container = $('workers');
  preserveFocus(container, () => {
    container.replaceChildren();
    if (!fleet.workers.length) {
      container.append(emptyState('Your first worker is one pairing away.', 'Pair a computer to process jobs. You can also run a worker on this machine.'));
      return;
    }
    for (const worker of fleet.workers) {
      const card = node('article', 'worker');
      const heading = node('div', 'worker-top');
      const details = node('div');
      const state = node('span', 'worker-state');
      state.append(node('span', worker.online ? 'dot connected' : 'dot'), document.createTextNode(worker.online ? (worker.busy ? 'Working' : 'Ready for work') : 'Offline'));
      details.append(node('h3', '', worker.name || worker.id), state);
      heading.append(node('span', 'worker-icon', '▤'), details);
      const tags = node('div', 'tags');
      for (const capability of worker.capabilities || []) tags.append(node('span', 'tag', capability));
      const footer = node('div', 'worker-footer');
      footer.append(node('span', '', `Seen ${formatDate(worker.lastSeen)}`), actionButton('Revoke', 'revoke', worker.id));
      card.append(heading, tags, footer);
      container.append(card);
    }
  });
}

function renderJobs() {
  const filter = $('job-filter').value;
  const jobs = [...fleet.jobs].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).filter((job) => {
    if (filter === 'active') return ['queued', 'running'].includes(job.status);
    if (filter === 'completed') return job.status === 'completed';
    if (filter === 'failed') return ['failed', 'cancelled'].includes(job.status);
    return true;
  });
  preserveFocus($('jobs'), () => {
    $('jobs').replaceChildren();
    if (!jobs.length) {
      $('jobs').append(emptyState(filter === 'all' ? 'Nothing in the queue. Yet.' : 'No matching jobs.', filter === 'all' ? 'Send a small text job to see your fleet in action.' : 'Try a different filter or send a new job.', '↗'));
      return;
    }
    for (const job of jobs) {
      const row = node('article', 'job');
      const details = node('div');
      details.append(node('div', 'job-title', labels[job.kind] || job.kind), node('div', 'job-subtitle', `${String(job.id).slice(0, 8)} · ${formatDate(job.createdAt)}`));
      const status = node('span', 'status', job.status);
      if (['queued', 'running', 'completed', 'failed', 'cancelled'].includes(job.status)) status.classList.add(job.status);
      const actions = node('div', 'job-actions');
      actions.append(actionButton('Inspect', 'inspect', job.id));
      if (['queued', 'running'].includes(job.status)) actions.append(actionButton('Cancel', 'cancel', job.id));
      row.append(details, status, actions);
      $('jobs').append(row);
    }
  });
}

function capabilityHint() {
  const matching = fleet.workers.filter((worker) => worker.online && worker.capabilities?.includes($('kind').value));
  $('capability-hint').textContent = matching.length ? `${matching.length} online worker${matching.length === 1 ? '' : 's'} can handle this job.` : 'No matching worker is online. The job will wait in the queue until one connects.';
}

function render() {
  $('online-count').textContent = fleet.workers.filter((worker) => worker.online).length;
  $('running-count').textContent = fleet.jobs.filter((job) => job.status === 'running').length;
  $('queued-count').textContent = fleet.jobs.filter((job) => job.status === 'queued').length;
  $('completed-count').textContent = fleet.jobs.filter((job) => job.status === 'completed').length;
  $('clear-history').disabled = !fleet.jobs.some((job) => ['completed', 'failed', 'cancelled'].includes(job.status));
  renderWorkers();
  renderJobs();
  capabilityHint();
}

async function inspectJob(id) {
  const summary = fleet.jobs.find((job) => job.id === id);
  if (!summary) return;
  const requestGeneration = generation;
  const requestSequence = ++detailSequence;
  inspectedJobId = id;
  selectedJob = null;
  $('result-title').textContent = labels[summary.kind] || summary.kind;
  $('result-meta').replaceChildren();
  $('result-error').hidden = true;
  $('result-output').textContent = 'Loading job details…';
  $('download-result').hidden = true;
  $('result-dialog').showModal();
  try {
    const detail = await api(`/api/jobs/${encodeURIComponent(id)}`);
    if (requestGeneration !== generation || requestSequence !== detailSequence || !$('result-dialog').open) return;
    selectedJob = detail;
  } catch (error) {
    if (requestGeneration !== generation || requestSequence !== detailSequence || !$('result-dialog').open) return;
    $('result-error').hidden = false;
    $('result-error').textContent = readableError(error);
    $('result-output').textContent = 'Close this dialog and inspect the job again to retry.';
    return;
  }
  $('result-title').textContent = labels[selectedJob.kind] || selectedJob.kind;
  const metadata = $('result-meta');
  metadata.replaceChildren();
  const worker = fleet.workers.find((item) => item.id === selectedJob.workerId);
  for (const [key, value] of Object.entries({ Job: selectedJob.id, Status: selectedJob.status, Worker: worker?.name || selectedJob.workerId || 'Not assigned', Created: formatDate(selectedJob.createdAt) })) {
    metadata.append(node('dt', '', key), node('dd', '', value));
  }
  $('result-error').hidden = !selectedJob.error;
  $('result-error').textContent = selectedJob.error || '';
  const hasResult = Object.hasOwn(selectedJob, 'result');
  const output = hasResult ? JSON.stringify(selectedJob.result, null, 2) : (['failed', 'cancelled'].includes(selectedJob.status) ? 'This job ended without a result.' : 'No result yet. Close and inspect again after the job finishes.');
  $('result-output').textContent = output.length > PREVIEW_CHARACTERS ? `${output.slice(0, PREVIEW_CHARACTERS)}\n\nPreview truncated. Download the full result below.` : output;
  $('download-result').hidden = !hasResult;
}

function saveFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = node('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const value = $('token').value.trim();
  if (!value) return;
  announce('');
  setSession(value);
  $('token').value = '';
  connection('Connecting…');
  await refresh();
});
$('logout').addEventListener('click', () => { disconnect(); announce('Disconnected. The token has been removed from this tab.'); });
$('kind').addEventListener('change', () => {
  submissionIntent = null;
  const isModel = $('kind').value === 'ollama';
  $('model-field').hidden = !isModel;
  $('model').required = isModel;
  $('text-label').textContent = isModel ? 'Prompt' : 'Text to process';
  $('kind-help').textContent = descriptions[$('kind').value];
  capabilityHint();
});
function validateText() {
  const bytes = new TextEncoder().encode($('payload').value).length;
  const invalid = bytes > MAX_TEXT_BYTES;
  $('payload').setCustomValidity(invalid ? 'Text exceeds 128 KiB in UTF-8. Shorten it before sending.' : '');
  $('payload').setAttribute('aria-invalid', String(invalid));
  $('char-count').textContent = `${bytes.toLocaleString()} / ${MAX_TEXT_BYTES.toLocaleString()} UTF-8 bytes`;
  $('char-count').classList.toggle('danger', invalid);
  return !invalid;
}
$('payload').addEventListener('input', () => { submissionIntent = null; validateText(); });
$('model').addEventListener('input', () => { submissionIntent = null; });
$('example').addEventListener('click', () => {
  $('payload').value = $('kind').value === 'ollama' ? 'Explain distributed job queues in three short sentences.' : 'A small fleet can do useful work.\nPocketFleet sends this text to an available worker.\nYour computers, working together.';
  $('payload').dispatchEvent(new Event('input'));
  $('payload').focus();
});
$('job-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submitting || !validateText()) return;
  submitting = true;
  const kind = $('kind').value;
  const payload = kind === 'ollama' ? { model: $('model').value.trim(), prompt: $('payload').value } : { text: $('payload').value };
  const body = JSON.stringify({ kind, payload });
  if (submissionIntent?.body !== body) submissionIntent = { body, key: newSubmissionKey() };
  const intent = submissionIntent;
  $('submit-job').disabled = true;
  try {
    await api('/api/jobs', { method: 'POST', body, headers: { 'Idempotency-Key': intent.key } });
    if (submissionIntent === intent) submissionIntent = null;
    announce(`${labels[kind]} queued. A matching worker will pick it up.`);
    clearTimeout(pollTimer);
    await refresh();
  } catch (error) { reportError(error); }
  finally { submitting = false; $('submit-job').disabled = false; }
});
$('pair').addEventListener('click', async () => {
  $('pair').disabled = true;
  try {
    const result = await api('/api/pairing', { method: 'POST', body: '{}' });
    $('pairing').hidden = false;
    $('pair-command').textContent = `node src/cli.mjs worker --server ${location.origin} --code ${result.code} --name my-desktop`;
    $('pair-expiry').textContent = `Expires ${formatDate(result.expiresAt)}. Keep this code private.`;
    $('copy-pair').textContent = 'Copy command';
    $('pairing').scrollIntoView({ block: 'nearest', behavior: 'auto' });
  } catch (error) { reportError(error); }
  finally { $('pair').disabled = false; }
});
$('close-pair').addEventListener('click', () => { $('pairing').hidden = true; $('pair-command').textContent = ''; });
$('copy-pair').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('pair-command').textContent); $('copy-pair').textContent = 'Copied'; }
  catch { announce('Clipboard access is unavailable. Select and copy the command directly.', true); }
});
$('workers').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action="revoke"]');
  if (!button) return;
  const worker = fleet.workers.find((item) => item.id === button.dataset.id);
  if (!window.confirm(`Revoke ${worker?.name || 'this worker'}? It will need a new pairing code to reconnect.`)) return;
  button.disabled = true;
  try {
    await api(`/api/workers/${encodeURIComponent(button.dataset.id)}`, { method: 'DELETE' });
    announce('Worker access revoked.');
    clearTimeout(pollTimer);
    await refresh();
  } catch (error) { reportError(error); button.disabled = false; }
});
$('jobs').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  if (button.dataset.action === 'inspect') { inspectJob(button.dataset.id); return; }
  if (button.dataset.action !== 'cancel') return;
  button.disabled = true;
  try {
    await api(`/api/jobs/${encodeURIComponent(button.dataset.id)}/cancel`, { method: 'POST', body: '{}' });
    announce('Job cancelled. Late results will be discarded; a running worker will receive cancellation on its next heartbeat.');
    clearTimeout(pollTimer);
    await refresh();
  } catch (error) { reportError(error); button.disabled = false; }
});
$('job-filter').addEventListener('change', renderJobs);
$('clear-history').addEventListener('click', async () => {
  if (!window.confirm('Clear all completed, failed, and cancelled jobs? Download any results you want to keep first. Active jobs will stay.')) return;
  $('clear-history').disabled = true;
  try {
    await api('/api/jobs/completed', { method: 'DELETE' });
    announce('Finished jobs cleared. Active jobs remain in the queue.');
    clearTimeout(pollTimer);
    await refresh();
  } catch (error) { reportError(error); $('clear-history').disabled = false; }
});
$('close-result').addEventListener('click', () => $('result-dialog').close());
$('result-dialog').addEventListener('close', () => {
  detailSequence += 1;
  selectedJob = null;
  if (token) {
    const trigger = [...$('jobs').querySelectorAll('[data-action="inspect"]')].find((button) => button.dataset.id === inspectedJobId);
    (trigger || $('job-filter')).focus({ preventScroll: true });
  }
  inspectedJobId = null;
});
$('download-result').addEventListener('click', () => {
  if (!selectedJob || !Object.hasOwn(selectedJob, 'result')) return;
  try {
    const result = selectedJob.result;
    if (selectedJob.kind === 'gzip' && result?.encoding === 'base64' && typeof result.data === 'string') {
      const bytes = Uint8Array.from(atob(result.data), (character) => character.charCodeAt(0));
      saveFile(new Blob([bytes], { type: 'application/gzip' }), 'pocketfleet-output.txt.gz');
    } else saveFile(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }), `pocketfleet-${selectedJob.kind}.json`);
  } catch {
    $('result-error').hidden = false;
    $('result-error').textContent = 'This result could not be downloaded. Its artifact data is invalid.';
  }
});

if (token) { setSession(token); connection('Connecting…'); refresh(); }
