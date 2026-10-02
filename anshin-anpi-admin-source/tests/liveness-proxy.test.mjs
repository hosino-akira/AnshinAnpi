import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTerminalMiddleware } from '../build/local-terminal-proxy.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'anshin-proxy-'));
  const credentialsPath = join(directory, 'terminal.json');
  await writeFile(credentialsPath, JSON.stringify({ terminal_id: 'local-terminal', terminal_token: 'server-only-secret' }));
  const calls = [];
  const middleware = createTerminalMiddleware({ backendUrl: 'http://127.0.0.1:3002', credentialsPath,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response('{"status":"ok"}', { status: 201 }); } });
  const server = createServer((request, response) => {
    void middleware(request, response, () => { response.writeHead(404); response.end(); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true });
  });
  return { base, calls };
}

test('server attaches terminal credentials; client overrides cannot replace them', async t => {
  const { base, calls } = await fixture(t);
  const response = await fetch(`${base}/api/terminal/faces/liveness-sessions`, { method: 'POST',
    headers: { Origin: base, 'X-Terminal-Token': 'client-override', Authorization: 'Bearer session', 'Idempotency-Key': 'once' },
    body: '{"purpose":"safety"}' });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { status: 'ok' });
  assert.equal(calls[0].options.headers['X-Terminal-Token'], 'server-only-secret');
  assert.equal(calls[0].options.headers.authorization, 'Bearer session');
  assert.equal(calls[0].options.headers['idempotency-key'], 'once');
  assert.equal(calls[0].url.href, 'http://127.0.0.1:3002/v1/faces/liveness-sessions');
});

test('cross-origin requests cannot use terminal authentication', async t => {
  const { base, calls } = await fixture(t);
  const response = await fetch(`${base}/api/terminal/enrollments`, { method: 'POST', headers: { Origin: 'https://other.example' }, body: '{}' });
  assert.equal(response.status, 403);
  assert.equal(calls.length, 0);
});

test('webhook routes are outside the development proxy allowlist', async t => {
  const { base, calls } = await fixture(t);
  const response = await fetch(`${base}/api/terminal/mail/webhooks`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 404);
  assert.equal(calls.length, 0);
});

test('final registration and safety routes forward credentials, tokens and idempotency keys', async t => {
  const { base, calls } = await fixture(t);
  const id = '12345678-1234-4234-8234-123456789012';
  const routes = [['POST','/registrations/capture'],['POST','/registrations'],['POST','/registrations/verify'],
    ['GET',`/registrations/${id}`],['DELETE',`/registrations/${id}`],['POST',`/users/${id}/recipients`],
    ['POST','/safety-notifications'],['GET',`/mail-results/${id}`],['POST',`/mail-results/${id}/retry`]];
  for (const [method,path] of routes) {
    const response = await fetch(`${base}/api/terminal${path}`, {method,
      headers:{Origin:base,Authorization:'Bearer final-session','Idempotency-Key':'same-attempt'},
      ...(method === 'GET' ? {} : {body:'{}'})});
    assert.equal(response.status,201);
    const call=calls.at(-1);
    assert.equal(call.url.href,`http://127.0.0.1:3002/v1${path}`);
    assert.equal(call.options.headers['X-Terminal-Token'],'server-only-secret');
    assert.equal(call.options.headers.authorization,'Bearer final-session');
    assert.equal(call.options.headers['idempotency-key'],'same-attempt');
    if (method === 'GET') assert.equal(call.options.body,undefined);
  }
});

test('non-loopback hostnames cannot use terminal authentication', async t => {
  const { base, calls } = await fixture(t);
  const status = await new Promise((resolve, reject) => {
    const request = httpRequest(`${base}/api/terminal/terminal`, { headers: { Host: 'other.example' } }, response => {
      response.resume(); resolve(response.statusCode);
    });
    request.on('error', reject); request.end();
  });
  assert.equal(status, 403);
  assert.equal(calls.length, 0);
});

test('proxy rejects remote backends at configuration time', () => {
  assert.throws(() => createTerminalMiddleware({ backendUrl: 'https://other.example', credentialsPath: '' }), /loopback/);
});
