import { createHash } from 'node:crypto';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { LIMITS, requireValue, validateJob } from './config.mjs';

const compress = promisify(gzip);
export async function executeJob(job, { ollama, signal } = {}) {
  const payload = validateJob(job.kind, job.payload);
  signal?.throwIfAborted();
  if (job.kind === 'sha256') return { algorithm: 'sha256', digest: createHash('sha256').update(payload.text).digest('hex'), bytes: Buffer.byteLength(payload.text) };
  if (job.kind === 'gzip') {
    const data = await compress(Buffer.from(payload.text)); signal?.throwIfAborted();
    return { encoding: 'base64', data: data.toString('base64'), filename: 'output.txt.gz', inputBytes: Buffer.byteLength(payload.text), outputBytes: data.length };
  }
  if (job.kind === 'text-stats') {
    const text = payload.text;
    const counts = new Map();
    for (const { segment, isWordLike } of new Intl.Segmenter('en', { granularity: 'word' }).segment(text)) {
      if (isWordLike) { const key = segment.toLocaleLowerCase('en'); counts.set(key, (counts.get(key) ?? 0) + 1); }
    }
    return { bytes: Buffer.byteLength(text), characters: [...text].length, words: [...counts.values()].reduce((a, b) => a + b, 0), lines: text.length ? text.split(/\r?\n/).length : 0, topWords: [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10).map(([word, count]) => ({ word, count })) };
  }
  requireValue(ollama, 'Ollama is not enabled on this worker.');
  const endpoint = new URL('/api/generate', ollama);
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: payload.model, prompt: payload.prompt, stream: false, options: { num_predict: 1024, num_ctx: 4096 } }),
    redirect: 'error', signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(LIMITS.jobTimeoutMs - 5000)]),
  });
  requireValue(response.ok, `Ollama returned HTTP ${response.status}. Check the worker's model installation.`, 502);
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; requireValue(size <= LIMITS.resultBytes, 'Ollama response exceeded 512 KiB.'); chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  requireValue(typeof result.response === 'string', 'Ollama did not return generated text.');
  return { model: payload.model, response: result.response, evalCount: result.eval_count ?? null, durationNs: result.total_duration ?? null };
}
