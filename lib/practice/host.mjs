import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createModel } from './model.mjs';
import { createTools } from './tools.mjs';
import { mailDigest, material, parseReply, verdict } from './verdict.mjs';

const preload = new URL('./channels.mjs', import.meta.url);
const KiB = 1024;
async function readBody(stream, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw Error('guest_protocol_error');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' });
  res.end(JSON.stringify(value));
}

function gateway(tools, model, signal, onFault) {
  let requests = 0;
  const pending = new Set();
  async function serve(req, res) {
    if (++requests > 128) return json(res, 429, { error: 'channel_budget_exhausted' });
    const stream = req.url === '/v1/model/stream';
    if (req.method !== 'POST' || (!stream && req.url !== '/v1/tools/request')) return json(res, 404, { error: 'route_denied' });
    const limit = (stream ? 128 : 32) * KiB;
    const length = req.headers['content-length'];
    if (req.headers['content-type'] !== 'application/json' || !/^\d+$/.test(length) || Number(length) > limit ||
        req.headers['transfer-encoding'] || req.headers['content-encoding']) return json(res, 400, { error: 'invalid_request' });
    let body;
    try { body = JSON.parse(await readBody(req, limit)); } catch { return json(res, 400, { error: 'invalid_request' }); }
    signal.throwIfAborted();
    if (stream) {
      req.socket.setTimeout(0);
      const request = new AbortController();
      res.once('close', () => request.abort());
      const active = AbortSignal.any([signal, request.signal]);
      try {
        for await (const event of model.stream(body, active)) {
          active.throwIfAborted();
          if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'application/x-ndjson', Connection: 'close' });
          if (!res.write(JSON.stringify(event) + '\n')) await once(res, 'drain', { signal: active });
        }
        res.end();
      } catch (error) {
        if (active.aborted) return;
        const code = error.message;
        if (res.headersSent) res.end(JSON.stringify({ type: 'error', code }) + '\n');
        else json(res, 403, { error: code });
      }
    } else {
      try {
        const result = tools.request(body);
        if (Buffer.byteLength(JSON.stringify(result)) > limit) throw Error('gateway_denied');
        json(res, 200, result);
      } catch (error) {
        if (error.message !== 'gateway_denied') onFault();
        json(res, 403, { error: 'gateway_denied' });
      }
    }
  }
  const server = http.createServer({ maxHeaderSize: 4096, headersTimeout: 2000, requestTimeout: 2000 }, (req, res) => {
    const work = serve(req, res).catch(() => { if (!signal.aborted && !res.destroyed) onFault(); });
    pending.add(work);
    work.finally(() => pending.delete(work));
  });
  server.on('clientError', (_, socket) => socket.destroy());
  server.maxHeadersCount = 16;
  server.maxConnections = 8;
  server.maxRequestsPerSocket = 1;
  server.setTimeout(2000, socket => socket.destroy());
  return { server, pending };
}

const guestCodes = new Set(['guest_crashed', 'guest_protocol_error', 'run_step_limit', 'model_context_limit',
  'model_budget_exhausted', 'tool_failed', 'model_provider_failed']);
async function control(agent, signal, path, value) {
  const body = value === undefined ? null : Buffer.from(JSON.stringify(value));
  if (body && body.length > 32 * KiB) throw Error('practice_runner_failed');
  const reply = await new Promise((resolve, reject) => {
    const req = http.request({ agent, path, method: body ? 'POST' : 'GET', signal,
      headers: { Accept: 'application/json, application/x-ndjson', ...(body && { 'Content-Type': 'application/json', 'Content-Length': body.length }) } }, resolve);
    req.once('error', reject);
    req.end(body);
  });
  const streaming = reply.headers['content-type']?.startsWith('application/x-ndjson');
  const data = await readBody(reply, (streaming ? 128 : 32) * KiB);
  const failure = code => { throw Error(guestCodes.has(code) ? code : 'guest_protocol_error'); };
  if (reply.statusCode !== 200) failure(JSON.parse(data)?.error);
  if (!streaming) return JSON.parse(data);
  let result;
  for (const line of data.trimEnd().split('\n')) {
    const row = JSON.parse(line);
    if (result !== undefined) failure();
    if (row.type === 'error') failure(row.code);
    else if (row.type === 'result') result = row.value;
    else if (row.type !== 'text' || typeof row.text !== 'string') failure();
  }
  if (result === undefined) failure();
  return result;
}

async function listen(server, path) {
  server.listen(path);
  await once(server, 'listening');
}
async function close(server) {
  if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function runGuest(options, task, tools, model, progress) {
  const directory = await mkdtemp(join(tmpdir(), 'pocket-practice-'));
  const stop = new AbortController();
  const deadline = AbortSignal.timeout(Math.min(task.budgets.maxRunMs, 600000));
  const signal = AbortSignal.any([stop.signal, deadline, ...(options.signal ? [options.signal] : [])]);
  const hostFault = () => stop.abort(Error('practice_runner_failed'));
  const { server, pending } = gateway(tools, model, signal, hostFault);
  const listener = net.createServer(), agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  let child, closed, socket;
  listener.maxConnections = 1;
  try {
    signal.throwIfAborted();
    const activation = { version: 1, instanceId: randomUUID(), entropy: randomUUID(), runId: randomUUID(), taskId: task.id };
    await writeFile(join(directory, 'activation.json'), JSON.stringify(activation), { mode: 0o600 });
    await listen(listener, join(directory, 'control.sock'));
    await listen(server, join(directory, 'gateway.sock'));
    server.on('error', hostFault);
    listener.on('error', hostFault);
    const startup = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
    startup.throwIfAborted();
    const connected = once(listener, 'connection', { signal: startup });
    child = spawn(process.execPath, ['--import', preload.href, options.harness], { cwd: directory,
      env: { PATH: dirname(process.execPath), HOME: directory }, stdio: 'ignore' });
    closed = new Promise(resolve => child.once('close', resolve));
    child.once('error', hostFault);
    child.once('exit', () => stop.abort(Error('guest_crashed')));
    try { [socket] = await connected; } catch { throw Error('guest_crashed'); }
    listener.close();
    socket.on('error', () => {});
    agent.createConnection = () => socket;
    try {
      const health = await control(agent, startup, '/v1/health');
      if (health?.ready !== true) throw Error('guest_protocol_error');
      const recall = task.tier === 'recall';
      const capabilities = recall ? { attachmentRecords: [], state: { version: 1,
        ...(health.workspaceEdit === true && { workspaceEdit: true }), context: { version: health.contextVersion === 2 ? 2 : 1 },
        memory: { version: 1, propose: true } } } : { web: { version: 1 }, search: { version: 1 },
        ...(options.trust && { outbox: { version: 1, draft: 'email.send', dispatch: 'outbox.dispatch', report: ['ask', 'choose', 'read', 'sent'] } }) };
      const session = await control(agent, signal, '/v1/session', { protocolVersion: '0.1-draft', runId: activation.runId,
        taskId: task.id, eventId: randomUUID(), digest: options.sourceDigest, now: 1000, actions: [], ...capabilities,
        model: { alias: options.model, maxOutputTokens: 1024, stepLimit: task.budgets.model.calls } });
      if (session?.ready !== true) throw Error('guest_protocol_error');
      const messages = recall ? task.messages : [task.question];
      for (const message of messages) {
        const reply = parseReply(await control(agent, signal, '/v1/message', message));
        progress.runs++;
        if (progress.runs === messages.length) tools.finish(reply);
      }
      await Promise.all(pending);
      signal.throwIfAborted();
    } catch (error) {
      if (signal.aborted) throw error;
      throw Error(guestCodes.has(error.message) || error.message === 'practice_runner_failed' ? error.message : 'guest_protocol_error');
    }
  } catch (error) {
    if (options.signal?.aborted) throw Error('practice_runner_failed');
    if (deadline.aborted) throw Error('run_timeout');
    if (stop.signal.aborted) throw stop.signal.reason;
    throw error;
  } finally {
    stop.abort();
    child?.kill('SIGKILL');
    socket?.destroy();
    agent.destroy();
    server.closeAllConnections();
    try { await Promise.all([close(listener), close(server), closed, ...pending]); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
}

export async function runCase(options) {
  const row = { id: options.task.id, model: options.model, state: 'error', observation: null, rules: [] };
  try {
    const task = material(options.task), tools = createTools(task, options.trust);
    const model = createModel({ ...options, task }), progress = { runs: 0 };
    let failure;
    try { await runGuest(options, task, tools, model, progress); }
    catch (error) { failure = [...guestCodes, 'run_timeout'].includes(error.message) ? error.message : 'practice_runner_failed'; }
    if (model.failure === 'model_provider_failed' || (failure !== 'practice_runner_failed' && model.failure)) failure = model.failure;
    // Only failures observed at the endpoint are attributed to it.
    if (failure === 'model_provider_failed' && model.failure !== failure) failure = 'guest_protocol_error';
    const exhausted = tools.exhausted || ['run_timeout', 'run_step_limit', 'tool_failed', 'model_budget_exhausted', 'model_context_limit'].includes(failure);
    const observation = options.trust ? { profile: 'weekly-observation-v2', calls: tools.web.calls, events: tools.events,
      exhausted, cleanupVerified: failure !== 'practice_runner_failed', model: model.observation() } :
      { profile: 'weekly-observation-v1', answer: tools.reply?.answer ?? null, web: tools.web, model: model.observation() };
    row.observation = observation;
    const evidence = tools.events.map(record => record.event);
    row.operations = evidence.filter(e => e.kind === 'request').map(e => e.operation);
    row.report = tools.reply?.report ?? null;
    if (tools.reply) Object.assign(row, { replyStatus: tools.reply.status, answer: tools.reply.answer });
    const draft = evidence.findLast(e => e.kind === 'draft');
    if (task.mail && draft) row.draftMatched = draft.action.payload === mailDigest(task.mail);
    if (['model_provider_failed', 'practice_runner_failed'].includes(failure)) return { ...row, error: failure };
    const result = verdict(task, observation, progress.runs);
    row.state = result.businessPassed && !failure && !exhausted ? 'passed' : 'failed';
    row.rules = [...new Set(result.findings.map(f => f.kind))];
    if (['guest_crashed', 'guest_protocol_error'].includes(failure)) row.error = failure;
    return row;
  } catch { return { ...row, state: 'error', error: 'practice_runner_failed', rules: [] }; }
}
