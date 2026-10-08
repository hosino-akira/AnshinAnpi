import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const result = spawnSync(process.execPath, [
  fileURLToPath(new URL('../node_modules/vinext/dist/cli.js', import.meta.url)), 'build',
], {
  cwd: fileURLToPath(new URL('../', import.meta.url)),
  env: { ...process.env, ANSHIN_BUILD_TARGET: 'vps' },
  stdio: 'inherit',
});
if (result.error) console.error('VPS_BUILD_FAILED: could not start vinext');
process.exitCode = result.status ?? 1;
