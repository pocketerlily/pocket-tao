import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import test from 'node:test';

const harness = new URL('../examples/minimal/harness.mjs', import.meta.url);
const preload = new URL('./fixtures/guest-channels.mjs', import.meta.url);
const marker = '{"pocketStartup":"activation-wait"}\n';

async function startup(t, entropy) {
  const dir = await mkdtemp(join(tmpdir(), 'miner-start-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const record = { version: 1, runId: 'run', taskId: 'task' };
  const file = join(dir, 'activation.json');
  const env = { ...process.env };
  delete env.POCKET_CLUSTER_ACTIVATION;
  if (entropy === undefined) {
    delete env.POCKET_ACTIVATION_REQUIRED;
    await writeFile(file, JSON.stringify(record));
  } else {
    env.POCKET_ACTIVATION_REQUIRED = '1';
    Object.assign(record, { instanceId: 'guest', entropy });
  }

  const host = createServer();
  host.listen(join(dir, 'control.sock'));
  await once(host, 'listening');
  t.after(() => host.close());
  const connected = once(host, 'connection');
  const child = fork(harness, { cwd: dir, env, execArgv: ['--import', preload.href], silent: true, timeout: 5000 });
  t.after(() => child.kill());
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  const stderr = text(child.stderr);
  const closed = once(child, 'close').then(async ([code, signal]) => {
    assert.equal(code, 0, (await stderr) || String(signal));
  });

  async function checkHealth() {
    if (entropy !== undefined) {
      const [[message]] = await Promise.all([once(child, 'message'), once(child.stdout, 'data')]);
      assert.equal(message, 'waiting');
      assert.equal(stdout, marker);
      await writeFile(file, JSON.stringify(record));
    }
    const [socket] = await connected;
    socket.write('GET /v1/health HTTP/1.0\r\n\r\n');
    const response = await text(socket);
    assert.match(response, /^HTTP\/1\.1 200 /);
    return JSON.parse(response.split('\r\n\r\n')[1]);
  }
  const [health] = await Promise.all([checkHealth(), closed]);
  assert.equal(stdout, entropy === undefined ? '' : marker);
  return health;
}

test('cold start serves the original health reply without a wait marker', async t => {
  assert.deepEqual(await startup(t), { ready: true });
});

test('production start waits for activation and binds health to the instance and entropy', async t => {
  const first = await startup(t, 'first');
  const second = await startup(t, 'second');
  for (const health of [first, second]) {
    assert.equal(health.ready, true);
    assert.equal(health.instanceId, 'guest');
    assert.match(health.instanceNonce, /^[a-f0-9]{64}$/);
  }
  assert.notEqual(first.instanceNonce, second.instanceNonce);
});
