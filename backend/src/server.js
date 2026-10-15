import { createRuntime } from './runtime.js';
import { createApp } from './app.js';
import { MailWorker } from './mail-worker.js';
import { MailBounceMonitor } from './mail-bounce-monitor.js';

try {
  const runtime = await createRuntime();
  const app = await createApp(runtime);
  const worker = new MailWorker(runtime);
  const bounces = new MailBounceMonitor(runtime);
  await app.listen({ host: runtime.config.host, port: runtime.config.port });
  if (runtime.config.workerEnabled) worker.start(app.log);
  bounces.start(app.log);
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    await bounces.stop(); await worker.stop(); await app.close(); await runtime.close();
  };
  process.on('SIGINT', () => stop().then(() => process.exit(0)));
  process.on('SIGTERM', () => stop().then(() => process.exit(0)));
} catch {
  console.error('API_STARTUP_FAILED: 環境変数、PostgreSQL の SQL 適用状況、同意文面の設定を確認してください。');
  process.exitCode = 1;
}
