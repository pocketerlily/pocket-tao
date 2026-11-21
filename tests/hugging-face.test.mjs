import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { verifyRemote } from '../lib/hugging-face.mjs';
import { maxSourceBytes, packFlat, sha256 } from '../lib/source.mjs';
import { submissionIdentity } from '../lib/submission.mjs';

const executable = fileURLToPath(new URL('../pocket-miner', import.meta.url));
const exec = promisify(execFile);
const hotkey = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const round = 'sha256:' + 'a'.repeat(64);
const repo = 'alice/pocket-harness';
const base = sha256('base');
const source = packFlat(base, [['build.mjs', Buffer.from('// fixture')]]);
const identity = submissionIdentity(1, hotkey, round, sha256(source), repo);
const repoPath = 'pocket/' + identity.id.slice(7) + '.json';
const flags = ['--netuid', '1', '--hotkey', hotkey, '--round', round, '--source', 'source.json', '--repo', repo];

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'miner-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'source.json'), source);
  return cwd;
}

test('p2 commitment matches the fixed ASCII vector and preserves the submission ID', () => {
  const sourceDigest = 'sha256:' + 'b'.repeat(64);
  const hex = '43b1c93a558d2d0c90e8e0c7faf5a674232cee3cd0dfb0988b01280ca088dcd8';
  const actual = submissionIdentity(1, hotkey, round, sourceDigest, repo);
  assert.equal(actual.id, 'sha256:' + hex);
  assert.equal(actual.id, submissionIdentity(1, hotkey, round, sourceDigest).id);
  assert.deepEqual(Buffer.from(actual.commitment), Buffer.from('p2:' + hex + ':alice/pocket-harness', 'ascii'));
});

test('repo validation enforces component syntax and the Raw128 boundary', () => {
  const commitment = name => submissionIdentity(1, hotkey, round, sha256(source), name).commitment;
  const longest = 'A'.repeat(42) + '/' + 'B'.repeat(17);
  assert.equal(Buffer.byteLength(commitment(longest)), 128);
  assert.ok(commitment('0/A_z-9.'));
  for (const name of [longest + 'x', 'A'.repeat(43) + '/b', 'a/b..c', 'a--b/c', 'abc', '/n',
    'a/', 'a/b/c', '.a/b', 'a/_b', 'a/b:c', 'a/é', 'a/b\n', '']) {
    assert.throws(() => commitment(name), /--repo.*60 characters/);
  }
});

test('submission-id and guarded commit use the same p2 string', async t => {
  const cwd = await fixture(t);
  const cli = args => exec(process.execPath, [executable, ...args], { cwd });
  assert.deepEqual(JSON.parse((await cli(['submission-id', ...flags])).stdout), identity);
  await assert.rejects(cli(['commit', ...flags]), { code: 1, stdout: '', stderr: 'Commit requires --allow-writes\n' });
  const helper = join(cwd, 'wallet-double');
  await writeFile(helper, '#!/usr/bin/env node\nlet input = ""; for await (const part of process.stdin) input += part;\n' +
    'console.log(JSON.stringify({value:{receipt:JSON.parse(input).commitment}}));\n', { mode: 0o700 });
  const result = await cli(['commit', ...flags, '--hotkey-file', 'dummy', '--network', 'test', '--python', helper, '--allow-writes']);
  assert.equal(JSON.parse(result.stdout).receipt, identity.commitment);
});

test('publish stages exact source bytes and supplies the printed arguments to the upload CLI', async t => {
  const cwd = await fixture(t);
  const bin = join(cwd, 'bin');
  await mkdir(bin);
  const opts = { cwd, env: { PATH: bin } };
  const args = [executable, 'publish', ...flags, '--out', 'out'];
  const prepared = await exec(process.execPath, args, opts);
  const local = join('out', repoPath);
  const uploadArgs = ['upload', repo, local, repoPath];
  assert.deepEqual(JSON.parse(prepared.stdout), { ...identity, repoPath, uploadCommand: 'hf ' + uploadArgs.join(' ') });
  assert.equal(prepared.stdout.trimEnd().split('\n').length, 1);
  assert.deepEqual(await readFile(join(cwd, local)), source);

  const upload = () => exec(process.execPath, [...args, '--upload'], opts);
  await assert.rejects(upload(), error => error.code === 1 && /install the Hugging Face CLI or upload.*by hand/i.test(error.stderr));
  const fake = '#!/bin/sh\nprintf "%s\\n" "$0" "$@" > upload-args\nprintf "cli output"\n';
  await writeFile(join(bin, 'hf'), fake, { mode: 0o700 });
  await writeFile(join(bin, 'huggingface-cli'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  assert.equal((await upload()).stdout, prepared.stdout);
  assert.deepEqual((await readFile(join(cwd, 'upload-args'), 'utf8')).trimEnd().split('\n'), [join(bin, 'hf'), ...uploadArgs]);
  await rename(join(bin, 'hf'), join(bin, 'huggingface-cli'));
  assert.equal((await upload()).stdout, prepared.stdout);
  assert.deepEqual((await readFile(join(cwd, 'upload-args'), 'utf8')).trimEnd().split('\n'), [join(bin, 'huggingface-cli'), ...uploadArgs]);
});

test('verify-remote downloads anonymously on loopback and reports each outcome and exit code', async t => {
  const cwd = await fixture(t);
  let reply;
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ path: req.url, auth: req.headers.authorization, cookie: req.headers.cookie });
    reply(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const firstPath = '/' + repo + '/resolve/main/' + repoPath;
  async function verify(status, handler, testBase = origin) {
    requests.length = 0;
    reply = handler;
    const opts = { cwd, env: { ...process.env, POCKET_MINER_HF_BASE_URL: testBase }, timeout: 15_000 };
    const result = exec(process.execPath, [executable, 'verify-remote', ...flags], opts);
    if (status === 'ok') assert.equal((await result).stdout, 'ok\n');
    else await assert.rejects(result, { code: 1, stdout: status + '\n', stderr: '' });
  }
  const body = bytes => (_req, res) => res.end(bytes);
  await verify('ok', body(source));
  assert.deepEqual(requests, [{ path: firstPath, auth: undefined, cookie: undefined }]);
  for (const code of [401, 403, 404]) await verify('not_public', (_req, res) => res.writeHead(code).end());
  await verify('mismatch', body(packFlat(base, [['build.mjs', Buffer.from('// changed')]])));
  await verify('invalid', body(Buffer.concat([source, Buffer.from('\n')])));
  await verify('invalid', body('bad JSON'));
  await verify('invalid', body(packFlat(sha256('other base'), [['build.mjs', Buffer.from('// fixture')]])));
  await verify('invalid', (_req, res) => res.write(Buffer.alloc(maxSourceBytes + 1))); // No EOF.
  await verify('unreachable', (_req, res) => res.writeHead(503).end());
  await verify('unreachable', (_req, res) => res.destroy());

  const redirect = count => (req, res) => {
    const hop = req.url === firstPath ? 0 : Number(req.url.slice(1));
    if (hop === count) return res.end(source);
    res.writeHead(302, { location: '/' + (hop + 1), 'set-cookie': 'mock=value' }).end();
  };
  await verify('ok', redirect(5));
  assert.equal(requests.length, 6);
  assert.ok(requests.every(req => req.auth === undefined && req.cookie === undefined));
  await verify('unreachable', redirect(6));
  assert.equal(requests.length, 6);
  for (const badBase of [origin + '/extra', origin + '?q=1', origin.replace('http:', 'https:'), 'http://outside.invalid:80']) {
    await verify('unreachable', body(source), badBase);
    assert.equal(requests.length, 0);
  }
});

test('production redirects stay on allowed HTTPS hosts, without contacting the network', async t => {
  const hub = ['huggingface', 'co'].join('.');
  const cdn = ['hf', 'co'].join('.');
  const visited = [];
  let location;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.redirect, 'manual');
    assert.equal(options.credentials, 'omit');
    visited.push(url.href);
    return visited.length === 1 ? new Response(null, { status: 307, headers: { location } }) : new Response(source);
  });
  const verify = () => verifyRemote({ netuid: 1, hotkey, round, repo, id: identity.id, baseImageDigest: base });
  for (location of ['https://' + hub, 'https://files.' + hub, 'https://files.' + cdn]) {
    visited.length = 0;
    assert.equal(await verify(), 'ok');
    assert.deepEqual(visited, ['https://' + hub + '/' + repo + '/resolve/main/' + repoPath, location + '/']);
  }
  for (location of ['https://outside.invalid', 'https://' + hub + '.invalid', 'http://' + hub, 'https://user@' + hub, 'https://' + cdn]) {
    visited.length = 0;
    assert.equal(await verify(), 'unreachable');
    assert.equal(visited.length, 1);
  }
});
