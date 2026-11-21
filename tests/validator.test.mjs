import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readConfig } from '../validator/config.mjs';

const cli = fileURLToPath(new URL('../validator/pocket-validator', import.meta.url));
const helper = fileURLToPath(new URL('validator-chain', import.meta.url));
const exec = promisify(execFile);
const signer = '5CaypP6WQssk1JX2ouPkex2EPDwn3X2rv8MEU8juScA6aoqn';
const hotkey = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const submissionId = 'sha256:' + '1'.repeat(64);
const winner = { hotkey, score: 0.8, submissionId, commitBlock: 23 };

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'validator-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const doc = {
    format: 'pocket-champions-v1', network: 'test', netuid: 1, generatedAt: Date.now(), block: 120, secondsPerBlock: 12,
    round: { index: 1, startBlock: 101, endBlock: 200, blocksRemaining: 80 },
    champion: { ...winner, uid: 7, round: 0, sourceDigest: submissionId, sinceBlock: 110 },
    history: [{ round: 0, startBlock: 1, endBlock: 100, settledBlock: 110, champion: winner, submissions: 2, disqualified: 0 }],
  };
  const server = createServer((_req, res) => res.end(JSON.stringify(doc)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const config = { network: 'test', netuid: 1, resultsUrl: 'http://127.0.0.1:' + server.address().port + '/results',
    wallet: { name: 'validator', hotkey: 'default', path: cwd }, allowWrites: true };
  const chain = { epoch: 3, block: 125, tempo: 36, rateLimit: 5, maxWeight: 65535, signer,
    neurons: [{ uid: 0, hotkey: signer, validator_permit: true, last_update: 0 },
      { uid: 7, hotkey, validator_permit: false, last_update: 0 }] };
  const file = join(cwd, 'config.json');
  const save = () => writeFile(file, JSON.stringify(config));
  const options = () => ({ cwd, timeout: 15_000, env: { ...process.env, XDG_STATE_HOME: cwd,
    POCKET_VALIDATOR_PYTHON: helper, TEST_SUBNET: JSON.stringify(chain) } });
  async function poll(command = 'run') {
    const flags = command === 'run' ? ['--once'] : [];
    const { stdout, stderr } = await exec(cli, [command, '--config', file, ...flags], options());
    assert.equal(stdout.trimEnd().split('\n').length, 1);
    assert.doesNotMatch(stdout + stderr, /test-private-diagnostic/);
    return JSON.parse(stdout);
  }
  async function submissions() {
    try {
      return (await readFile(join(cwd, 'submissions.jsonl'), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }
  await save();
  return { doc, config, chain, file, save, options, poll, submissions };
}

test('status reports the verified allocation with writes enabled and only previews', async t => {
  const f = await fixture(t);
  const report = await f.poll('status');
  assert.deepEqual(report.champion, { hotkey, uid: 7 });
  assert.deepEqual(report.weights, [{ uid: 7, weight: 65535 }]);
  assert.equal(report.status, 'ready');
  assert.equal(report.wouldWrite, true);
  assert.deepEqual(report.checks, { document: true, network: true, netuid: true, fresh: true, chain: true,
    championRegistered: true, championUid: true, validatorRegistered: true, validatorPermit: true,
    tempo: true, rateLimit: true, weightLimit: true });
  assert.deepEqual(await f.submissions(), []);
});

test('run previews when write permission is omitted or false', async t => {
  const f = await fixture(t);
  for (const permission of [undefined, false]) {
    f.config.allowWrites = permission;
    await f.save();
    const report = await f.poll();
    assert.equal(report.status, 'writes_disabled');
    assert.equal(report.wouldWrite, false);
    assert.deepEqual(report.weights, [{ uid: 7, weight: 65535 }]);
  }
  assert.deepEqual(await f.submissions(), []);
});

test('stale and future timestamps, wrong subnet and malformed history block writes', async t => {
  const f = await fixture(t);
  const past = Date.now() - 7201_000;
  const future = Date.now() + 360_000;
  for (const [patch, code, check] of [
    [{ generatedAt: past }, 'result_stale', 'fresh'], [{ generatedAt: future }, 'result_in_future', 'fresh'],
    [{ netuid: 2 }, 'netuid_mismatch', 'netuid'], [{ network: 'finney' }, 'network_mismatch', 'network'],
    [{ history: [{}] }, 'invalid_document', 'document'], [{ format: 'other' }, 'invalid_document', 'document'],
  ]) {
    const original = { ...f.doc };
    Object.assign(f.doc, patch);
    const report = await f.poll();
    assert.equal(report.status, code);
    assert.equal(report.checks[check], false);
    assert.equal(report.wouldWrite, false);
    Object.assign(f.doc, original);
  }
  assert.deepEqual(await f.submissions(), []);
});

test('chain registration, UID, permit, tempo and rate checks each block writes', async t => {
  const f = await fixture(t);
  const [validator, miner] = f.chain.neurons;
  for (const [changes, code, check] of [
    [{ neurons: [validator] }, 'champion_not_registered', 'championRegistered'],
    [{ neurons: [validator, { ...miner, uid: 8 }] }, 'champion_uid_mismatch', 'championUid'],
    [{ neurons: [miner] }, 'validator_not_registered', 'validatorRegistered'],
    [{ neurons: [{ ...validator, validator_permit: false }, miner] }, 'validator_permit_required', 'validatorPermit'],
    [{ neurons: [{ ...validator, last_update: 124 }, miner] }, 'rate_limited', 'rateLimit'],
    [{ tempo: 0 }, 'tempo_disabled', 'tempo'], [{ maxWeight: 100 }, 'weight_limit', 'weightLimit'],
  ]) {
    const original = { ...f.chain };
    Object.assign(f.chain, changes);
    const report = await f.poll();
    assert.equal(report.status, code);
    assert.equal(report.checks[check], false);
    assert.equal(report.wouldWrite, false);
    Object.assign(f.chain, original);
  }
  assert.deepEqual(await f.submissions(), []);
});

test('a null champion leaves weights alone unless a fallback UID is configured', async t => {
  const f = await fixture(t);
  Object.assign(f.doc, { round: null, champion: null, history: [] });
  const empty = await f.poll();
  assert.equal(empty.status, 'no_target');
  assert.equal(empty.wouldWrite, false);
  assert.deepEqual(empty.weights, []);
  assert.deepEqual(await f.submissions(), []);

  f.config.emptyRoundUid = 0;
  await f.save();
  const fallback = await f.poll();
  assert.equal(fallback.status, 'submitted');
  assert.equal(fallback.champion, null);
  assert.deepEqual(await f.submissions(), [{ 0: 65535 }]);
});

test('a lost reply survives restart and a new submission waits until the next epoch', async t => {
  const f = await fixture(t);
  f.chain.loseReply = true;
  assert.equal((await f.poll()).status, 'outcome_unknown');
  f.chain.loseReply = false;
  const restart = await f.poll();
  assert.equal(restart.status, 'outcome_unknown');
  assert.equal(restart.wouldWrite, false);
  assert.deepEqual(await f.submissions(), [{ 7: 65535 }]);
  f.chain.epoch++;
  assert.equal((await f.poll()).status, 'submitted');
  assert.equal((await f.poll()).status, 'already_submitted');
  assert.deepEqual(await f.submissions(), [{ 7: 65535 }, { 7: 65535 }]);
});

test('concurrent live polls submit once', async t => {
  const f = await fixture(t);
  const reports = await Promise.all([f.poll(), f.poll()]);
  assert.equal(reports.filter(r => r.status === 'submitted').length, 1);
  assert.deepEqual(await f.submissions(), [{ 7: 65535 }]);
});

test('the polling loop fetches updated results on the next poll', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  Object.assign(f.config, { allowWrites: false, pollSeconds: 1 });
  await f.save();
  const child = spawn(cli, ['run', '--config', f.file], f.options());
  const closed = once(child, 'close');
  try {
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    assert.equal(JSON.parse((await lines.next()).value).status, 'writes_disabled');
    f.doc.champion = null;
    assert.equal(JSON.parse((await lines.next()).value).status, 'no_target');
    assert.deepEqual(await f.submissions(), []);
  } finally {
    child.kill();
    await closed;
  }
});

test('configuration uses preview defaults and requires an HTTPS or loopback results URL', async t => {
  const example = await readConfig(new URL('../validator/config.example.json', import.meta.url));
  assert.equal(example.resultsUrl.protocol, 'https:');
  assert.equal(example.allowWrites, false);
  const cwd = await mkdtemp(join(tmpdir(), 'validator-config-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const file = join(cwd, 'config.json');
  const config = { network: 'test', netuid: 1, wallet: { name: 'validator', hotkey: 'default', path: cwd } };
  const save = resultsUrl => writeFile(file, JSON.stringify({ ...config, resultsUrl }));
  await save('http://127.0.0.1:1234/results');
  const parsed = await readConfig(file);
  assert.deepEqual([parsed.pollSeconds, parsed.maxResultAgeSeconds, parsed.allowWrites], [600, 7200, false]);
  for (const url of ['http://127.0.0.1/results', 'file:///results', 'http://[::1]:1234/results']) {
    await save(url);
    await assert.rejects(readConfig(file));
  }
});
