import { createRuntime } from '../src/runtime.js';
import { ensureSingleTerminal } from '../src/single-terminal.js';

const runtime = await createRuntime();
try {
  if (runtime.config.production) throw new Error('Development provisioning is disabled in production');
  const terminal = await ensureSingleTerminal(runtime.pool);
  console.log(JSON.stringify({ terminal_id: terminal.terminal_id,
    terminal_code: terminal.terminal_code, status: terminal.status,
    terminal_headers_required: false }));
} finally { await runtime.close(); }
