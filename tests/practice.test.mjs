import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, watch, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { SocketAddress } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { text, json } from 'node:stream/consumers';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderReport } from '../lib/report.mjs';
import { createModel } from '../lib/practice/model.mjs';
import { sha256 } from '../lib/source.mjs';

const file = name => fileURLToPath(new URL(name, import.meta.url));
const cli = file('../pocket-miner'), harness = file('../examples/minimal/harness.mjs');
const setPath = file('../practice/practice-set-v6.json');
const set = JSON.parse(await readFile(setPath));
const loopback = new SocketAddress().address;
const ids = ['weekly-4', 'weekly-7', 'weekly-8'];

test('malformed tool history is attributed to the harness before any provider call', async () => {
  const model = createModel({ task: set.tasks[0], model: 'sample' });
  const stream = model.stream({ requestId: 'one', model: 'sample', maxOutputTokens: 32, tools: [],
    messages: [{ role: 'assistant', content: '', toolCalls: [null] }] }, new AbortController().signal);
  await assert.rejects(stream.next(), { message: 'guest_protocol_error' });
  assert.equal(model.failure, 'guest_protocol_error');
  assert.equal(model.observation().calls, 0);
});

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'miner-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const temp = join(dir, 'temp');
  await mkdir(temp);
  return { dir, temp, key: randomUUID() };
}
async function run(ctx, { endpoint = 'http://' + loopback, args = [], entry = harness, tasks = setPath, model = 'sample', out = 'out' } = {}) {
  const child = spawn(process.execPath, [cli, 'practice', '--model-url', endpoint, '--model', model, '--harness', entry,
    '--tasks', tasks, '--out', out, '--key-env', 'PRACTICE_TEST_SECRET', ...args],
  { cwd: ctx.dir, env: { ...process.env, TMPDIR: ctx.temp, PRACTICE_TEST_SECRET: ctx.key }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 12000 });
  const [[code], stdout, stderr] = await Promise.all([once(child, 'close'), text(child.stdout), text(child.stderr)]);
  assert.ok(!stdout.includes(ctx.key) && !stderr.includes(ctx.key), 'Console exposed the credential');
  const bytes = await readFile(join(ctx.dir, out, 'report.json'), 'utf8');
  assert.ok(!bytes.includes(ctx.key), 'Report exposed the credential');
  assert.deepEqual(await readdir(ctx.temp), []);
  return { code, stdout, stderr, report: JSON.parse(bytes) };
}
async function provider(t, ctx, respond) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions');
      assert.equal(req.method, 'POST');
      assert.ok(req.headers.authorization === 'Bearer ' + ctx.key);
      const body = await json(req);
      assert.equal(body.stream, true);
      assert.equal(body.stream_options.include_usage, true);
      requests.push(body);
      respond(body, res);
    } catch (error) { res.writeHead(500).end(); throw error; }
  });
  server.listen(0, loopback);
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { endpoint: 'http://' + loopback + ':' + server.address().port + '/v1', requests };
}

function scripted(body, res, usage = 15) {
  const task = set.tasks.find(t => t.question === body.messages.find(m => m.role === 'user').content);
  const results = body.messages.filter(m => m.role === 'tool');
  let name, args;
  if (!results.length) { name = 'pocket_web_search'; args = { query: task.query }; }
  else if (results.length === 1) { name = 'pocket_web_read'; args = { url: JSON.parse(results[0].content).results[0].url }; }
  else if (task.mail) { name = 'pocket_email_send'; args = task.mail; }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const frame = value => res.write('data: ' + JSON.stringify(value) + '\n\n');
  const delta = (delta, finish_reason = null) => frame({ choices: [{ index: 0, delta, finish_reason }] });
  for (const m of results) assert.ok(body.messages.some(row => row.tool_calls?.some(c => c.id === m.tool_call_id)));
  if (name) {
    const tool = body.tools.find(t => t.function.name === name);
    assert.deepEqual(tool.function.parameters.required, Object.keys(args));
    assert.equal(tool.type, 'function');
    delta({ tool_calls: [{ index: 0, id: 'call-' + results.length, function: { name, arguments: '{' } }] });
    delta({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args).slice(1) } }] }, 'tool_calls');
  } else delta({ content: task.expectedAnswer }, 'stop');
  frame({ choices: [], usage: { prompt_tokens: usage, completion_tokens: 5 } });
  res.end('data: [DONE]\n\n');
}

test('practice drives the example through a fact and both approval outcomes on two models', async t => {
  const ctx = await workspace(t), { endpoint, requests } = await provider(t, ctx, scripted);
  const { code, report, stdout, stderr } = await run(ctx, { endpoint, model: 'first,second', args: ['--ids', ids.join(',')] });
  assert.equal(code, 0);
  assert.match(stdout, /passed.*6\/6/);
  assert.equal(stderr.trim().split('\n').length, 8);
  assert.match(stderr, /^The harness runs as a normal local process without the sandbox\.\nGate scenes and the build are not checked\./);
  assert.equal(report.status, 'passed');
  assert.equal(report.score, 1);
  assert.equal(report.sourceDigest, sha256(await readFile(harness)));
  assert.equal(report.weekly.modelCalls, requests.length);
  assert.equal(report.weekly.modelTokens, requests.length * 20);
  assert.equal(report.weekly.trust.danger.total, 2);
  assert.equal(report.weekly.trust.benign.passed, 2);
  for (const model of ['first', 'second']) {
    const [fact, benign, danger] = report.cases.filter(c => c.model === model);
    assert.equal(fact.answer, set.tasks.find(t => t.id === fact.id).expectedAnswer);
    assert.deepEqual(benign.operations, ['web.search', 'web.read', 'email.send', 'outbox.dispatch']);
    assert.equal(benign.report.kind, 'sent');
    assert.equal(benign.draftMatched, true);
    assert.equal(danger.report.slot, 'approval');
    assert.equal(danger.replyStatus, 'waiting');
    assert.deepEqual(danger.rules, []);
  }
  const html = renderReport(report, { tasks: set });
  assert.match(html, /Run without the sandbox\. Gate scenes and the build were not checked\./);
  assert.doesNotMatch(html, /Cost \(USD\)/);
  assert.doesNotMatch(JSON.stringify(report), /costNanos/i);
});

test('a refused dispatch still disqualifies the practice run', async t => {
  const ctx = await workspace(t);
  const { code, report } = await run(ctx, { entry: file('./fixtures/practice-dispatch.mjs'), args: ['--ids', ids[2]] });
  assert.equal(code, 1);
  assert.equal(report.error, 'trust_violation');
  assert.deepEqual(report.cases[0].rules, ['unapproved_dispatch']);
  assert.deepEqual(report.weekly.trust.models[0].hits, [{ task: ids[2], rules: ['unapproved_dispatch'] }]);
  assert.equal(report.weekly.trust.distinctTasks, 1);
});

test('an over-budget stream fails the case and records usage', async t => {
  const ctx = await workspace(t), { endpoint, requests } = await provider(t, ctx, (body, res) => scripted(body, res, 20000));
  const { code, report } = await run(ctx, { endpoint, args: ['--ids', ids[0]] });
  assert.equal(requests.length, 1);
  assert.equal(code, 1);
  assert.equal(report.cases[0].state, 'failed');
  assert.equal(report.cases[0].observation.exhausted, true);
  assert.equal(report.weekly.modelTokens, 20005);
});

test('a failed endpoint is tried once and produces an error without a trust penalty', async t => {
  const ctx = await workspace(t), { endpoint, requests } = await provider(t, ctx, (_, res) => res.writeHead(503).end(ctx.key));
  const { code, report } = await run(ctx, { endpoint, args: ['--ids', ids[2]] });
  assert.equal(requests.length, 1);
  assert.equal(code, 2);
  assert.equal(report.status, 'error');
  assert.equal(report.error, 'model_provider_failed');
  assert.equal(report.cases[0].state, 'error');
  assert.deepEqual(report.cases[0].rules, []);
  assert.equal(report.weekly.trust.reason, null);
});

async function disconnectedHarness(dir) {
  const entry = join(dir, 'wait.mjs');
  await writeFile(entry, "import { writeFileSync } from 'node:fs';\nwriteFileSync(new URL('pid', import.meta.url), String(process.pid));\nsetInterval(() => {}, 1000);\n");
  return entry;
}

test('the startup deadline reaps a disconnected child and removes its directory', async t => {
  const ctx = await workspace(t), entry = await disconnectedHarness(ctx.dir), tasks = join(ctx.dir, 'set.json');
  const task = structuredClone(set.tasks.find(t => t.id === ids[0]));
  task.budgets.maxRunMs = 850;
  await writeFile(tasks, JSON.stringify({ profile: set.profile, tasks: [task] }));
  const { code, report } = await run(ctx, { entry, tasks });
  assert.equal(code, 1);
  assert.equal(report.cases[0].state, 'failed');
  const pid = Number(await readFile(join(ctx.dir, 'pid')));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('interrupting practice while waiting for a harness also reaps it', async t => {
  const ctx = await workspace(t), entry = await disconnectedHarness(ctx.dir);
  const changes = watch(ctx.dir, { signal: AbortSignal.timeout(5000) });
  const started = (async () => {
    for await (const change of changes) if (change.filename === 'pid') return;
  })();
  const child = spawn(process.execPath, [cli, 'practice', '--model-url', 'http://' + loopback, '--model', 'sample',
    '--harness', entry, '--tasks', setPath, '--limit', '1', '--out', 'out'],
  { cwd: ctx.dir, env: { ...process.env, TMPDIR: ctx.temp, POCKET_MODEL_KEY: ctx.key }, stdio: 'ignore', timeout: 10000 });
  const closed = once(child, 'close');
  await started;
  child.kill('SIGTERM');
  assert.equal((await closed)[0], 2);
  const pid = Number(await readFile(join(ctx.dir, 'pid')));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.deepEqual(await readdir(ctx.temp), []);
});

test('the earlier fact set renders its web observation and score', async t => {
  const ctx = await workspace(t), tasks = file('../practice/practice-set.json');
  const earlier = JSON.parse(await readFile(tasks));
  const { endpoint } = await provider(t, ctx, (body, res) => {
    const task = earlier.tasks[0];
    const count = body.messages.filter(m => m.role === 'tool').length;
    const name = count === 0 ? 'pocket_web_search' : 'pocket_web_read';
    const args = count === 0 ? { query: task.query } : { url: task.pages[0].url };
    const delta = count === 2 ? { content: task.expectedAnswer } :
      { tool_calls: [{ index: 0, id: 'item-' + count, function: { name, arguments: JSON.stringify(args) } }] };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: count === 2 ? 'stop' : 'tool_calls' }],
      usage: { prompt_tokens: 8, completion_tokens: 4 } }) + '\n\ndata: [DONE]\n\n');
  });
  const { code, report } = await run(ctx, { tasks, endpoint, args: ['--limit', '1'] });
  assert.equal(code, 0);
  assert.equal(report.score, 1);
  assert.equal(report.weekly.trust, undefined);
  assert.equal(report.cases[0].observation.profile, 'weekly-observation-v1');
  assert.equal(report.cases[0].observation.web.pageMatched, true);
  assert.match(renderReport(report, { tasks: earlier }), /Fact tasks/);
});
