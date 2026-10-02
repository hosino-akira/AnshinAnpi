import { createRuntime } from './runtime.js';
import { createApp } from './app.js';
import { MailWorker } from './mail-worker.js';

try {
  const runtime = await createRuntime();
  const app = await createApp(runtime);
  const worker = new MailWorker(runtime);
  await app.listen({ host: runtime.config.host, port: runtime.config.port });
  if (runtime.config.workerEnabled) worker.start(app.log);
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    await worker.stop(); await app.close(); await runtime.close();
  };
  process.on('SIGINT', () => stop().then(() => process.exit(0)));
  process.on('SIGTERM', () => stop().then(() => process.exit(0)));
} catch {
  console.error('API_STARTUP_FAILED: check local environment, PostgreSQL migrations, and Redis availability.');
  process.exitCode = 1;
}
