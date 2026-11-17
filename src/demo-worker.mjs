import { runWorker } from './worker.mjs';

// IPC ties each disposable worker to its coordinator process, including abrupt parent exit.
const controller = new AbortController();
process.once('disconnect', () => controller.abort());
process.once('message', async ({ server, token }) => {
  try {
    await runWorker({ server, token, signal: controller.signal });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    if (process.connected) process.disconnect();
  }
});
