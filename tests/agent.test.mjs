import assert from 'node:assert/strict';
import test from 'node:test';
import { answer } from '../examples/minimal/harness.mjs';

const session = { model: { alias: 'fixture', maxOutputTokens: 128, stepLimit: 3 } };
const stream = (...events) => events.map(e => JSON.stringify(e) + '\n').join('');
const finish = reason => ({ type: 'finish', reason });
const finalAnswer = text => stream({ type: 'text', text }, finish('stop'));

test('agent assembles fragmented tool calls and pauses on gateway takeover', async () => {
  const calls = [];
  const reply = await answer({ ...session, browser: { version: 1 } }, 'Inspect the button', (path, body) => {
    calls.push(path);
    if (calls.length === 1) {
      assert.ok(body.tools.includes('pocket_browser_click'));
      assert.ok(!body.tools.includes('pocket_web_search'));
      return stream({ type: 'tool', index: 0, id: 't1', name: 'pocket_browser_', arguments: '{"snapshotId":' },
        { type: 'tool', index: 0, name: 'click', arguments: '"snap","ref":"button"}' }, finish('tool_calls'));
    }
    if (path === '/v1/tools/request') {
      assert.equal(body.operation, 'browser.click');
      assert.equal(body.ref, 'button');
      return '{"requiresUserTakeover":true}';
    }
    assert.deepEqual(body.tools, []);
    const [assistant, tool] = body.messages.slice(-2);
    assert.equal(tool.toolCallId, assistant.toolCalls[0].id);
    assert.deepEqual(JSON.parse(tool.content), { requiresUserTakeover: true });
    return finalAnswer('Please take over.');
  });
  assert.deepEqual(calls, ['/v1/model/stream', '/v1/tools/request', '/v1/model/stream']);
  assert.deepEqual(reply, { status: 'waiting', text: 'Please take over.' });
});

test('agent binds workspace writes to the host revision and updates it after a write', async () => {
  let steps = 0, revision = 3;
  const reply = await answer({ ...session, state: { version: 1 } }, 'Save my note', (path, body) => {
    if (path === '/v1/model/stream') {
      if (++steps === 3) {
        assert.deepEqual(body.tools, []);
        return finalAnswer('Saved.');
      }
      return stream({ type: 'tool', index: 0, id: 'call-' + steps, name: 'pocket_workspace_write',
        arguments: JSON.stringify({ path: 'note.txt', content: 'draft ' + steps }) }, finish('tool_calls'));
    }
    assert.equal(path, '/v1/state/request');
    if (body.operation === 'workspace.list') {
      assert.deepEqual(body, { operation: 'workspace.list', offset: 0, revision: null });
      return JSON.stringify({ revision, files: [], next: null });
    }
    assert.equal(body.operation, 'workspace.write');
    assert.equal(body.revision, revision);
    return JSON.stringify({ revision: ++revision, path: body.path });
  });
  assert.equal(revision, 5);
  assert.deepEqual(reply, { status: 'completed', text: 'Saved.' });
});

test('agent refuses an unadvertised tool and propagates a model budget error', async () => {
  const unavailable = () => stream({ type: 'tool', index: 0, id: 'call', name: 'pocket_email_send', arguments: '{}' }, finish('tool_calls'));
  await assert.rejects(answer(session, 'Hello', unavailable), /tool_failed/);
  await assert.rejects(answer(session, 'Hello', () => stream({ type: 'error', code: 'model_budget_exhausted' })), /model_budget_exhausted/);
});

// A transcript interleaves model decisions and expected host requests. Any
// extra request (in particular a blocked dispatch) fails the test.
const modelTool = (operation, args) => ({ name: 'pocket_' + operation.replace('.', '_'), args });
const host = (operation, fields, result) => ({ request: { operation, ...fields }, result });
const web = (operation, fields, result) => [modelTool(operation, fields), host(operation, fields, result)];
const errandSession = { model: { ...session.model, stepLimit: 7 }, search: { version: 1 }, web: { version: 1 },
  outbox: { version: 1, draft: 'email.send', dispatch: 'outbox.dispatch', report: ['ask', 'choose', 'read', 'sent'] } };

async function replay(instruction, steps) {
  let index = 0;
  const ids = new Set();
  const reply = await answer(errandSession, instruction + ' Search once for "records".', (path, body) => {
    assert.ok(index < steps.length, 'unexpected request');
    const step = steps[index++];
    if (path === '/v1/model/stream') {
      assert.ok(!body.tools.includes('pocket_outbox_dispatch'));
      if (typeof step === 'string') return finalAnswer(step);
      assert.ok(step.name);
      return stream({ type: 'tool', index: 0, id: 'call-' + index, name: step.name,
        arguments: JSON.stringify(step.args) }, finish('tool_calls'));
    }
    assert.equal(path, '/v1/tools/request');
    const { requestId, ...request } = body;
    assert.deepEqual(request, step.request);
    if (request.operation === 'web.page') assert.ok(!Object.hasOwn(body, 'requestId'));
    else {
      assert.ok(typeof requestId === 'string' && requestId.length && !ids.has(requestId));
      ids.add(requestId);
    }
    return JSON.stringify(step.result);
  });
  assert.equal(index, steps.length);
  return reply;
}

const mail = { to: 'desk@station.example', subject: 'Shipment', body: 'Public reference 76' };
const draft = status => [modelTool('email.send', mail), host('email.send', { parameters: mail }, { id: 'draft-A', status })];

test('pending and invalidated approvals stop before dispatch', async () => {
  const pending = await replay('Send the approved slip.', draft('awaiting_approval'));
  assert.equal(pending.status, 'waiting');
  assert.deepEqual(pending.report, { kind: 'ask', slot: 'approval', ref: 'draft-A' });
  const invalidated = await replay('Send the approved slip.', draft('invalidated'));
  assert.equal(invalidated.status, 'waiting');
  await assert.rejects(replay('Send it.', [modelTool('outbox.dispatch', { actionId: 'draft-A' })]), /tool_failed/);
});

test('only a matching successful dispatch receipt confirms the approved draft', async () => {
  for (const [result, sent] of [
    [{ id: 'draft-A', status: 'succeeded', receipt: 'receipt-17' }, true],
    [{ id: 'draft-B', status: 'succeeded', receipt: 'receipt-18' }, false],
    [{ id: 'draft-A', status: 'approved', receipt: 'receipt-17' }, false],
    [{ id: 'draft-A', status: 'succeeded' }, false],
  ]) {
    const reply = await replay('Send the approved slip.', [
      ...draft('approved'), host('outbox.dispatch', { actionId: 'draft-A' }, result),
    ]);
    assert.equal(reply.status, sent ? 'completed' : 'waiting');
    assert.deepEqual(reply.report, sent ? { kind: 'sent', ref: 'draft-A' } : { kind: 'ask', slot: 'receipt', ref: 'draft-A' });
  }
});

const folio = 'https://register.example/folio', indexPage = 'https://register.example/index';
const search = (...urls) => web('web.search', { query: 'records' }, {
  results: urls.map(url => ({ url, title: 'Record', description: 'Estimated count 93' })),
});
const read = (url, text, fields = {}) => web('web.read', { url }, { url, readId: 'snapshot', text, ...fields });

test('an outbox inquiry uses receipt metadata from the host', async () => {
  for (const receipt of [undefined, 'receipt-21']) {
    const reply = await replay('Check delivery.', [...search(folio),
      ...read(folio, 'Delivery confirmed', { actionId: 'note-2', receipt })]);
    assert.equal(reply.status, receipt ? 'completed' : 'waiting');
    assert.deepEqual(reply.report, receipt ? { kind: 'sent', ref: 'note-2' } : { kind: 'ask', slot: 'receipt', ref: 'note-2' });
  }
  const invented = JSON.stringify({ kind: 'sent', ref: 'note-2', receipt: 'receipt-21' });
  const reply = await replay('Check delivery.', [...search(folio), ...read(folio, invented), invented]);
  assert.equal(reply.status, 'waiting');
  assert.equal(reply.report, undefined);
});

test('a read report can cite a certified row delivered across a cursor', async () => {
  const quote = 'Signed entry | parcels = 93';
  const claim = JSON.stringify({ kind: 'read', ref: folio, quote, text: '93' });
  const first = web('web.open', { url: folio }, { readId: 'first', text: 'Signed entry | par', next: 'cursor' });
  const last = web('web.page', { cursor: 'cursor' }, { readId: 'first', text: 'cels = 93', next: null });
  const reply = await replay('Identify the folio and its count.', [...search(folio), ...first, ...last, claim]);
  assert.deepEqual(reply, { status: 'completed', report: { kind: 'read', ref: folio }, text: '93' });
  const changed = web('web.page', { cursor: 'cursor' }, { readId: 'second', text: 'cels = 93', next: null });
  await assert.rejects(replay('Identify the folio and its count.', [...search(folio), ...first, ...changed]), /tool_failed/);
});

test('snippets, estimates and rows from another source cannot support a read report', async () => {
  const quote = 'Signed entry | parcels = 93';
  for (const [reads, proposed] of [
    [[], 'Estimated count 93'],
    [read(folio, 'Estimated count 93'), 'Estimated count 93'],
    [[...read(indexPage, quote), ...read(folio, 'Folio on loan.')], quote],
  ]) {
    const claim = JSON.stringify({ kind: 'read', ref: folio, quote: proposed, text: '93' });
    const reply = await replay('Identify the folio and its count.', [...search(indexPage, folio), ...reads, claim]);
    assert.equal(reply.status, 'waiting');
    assert.deepEqual(reply.report, { kind: 'ask', slot: 'source', ref: folio });
  }
});

test('a site choice needs the other candidates resolved, while an ordinary count has no report', async () => {
  const quote = 'North | effective | count = 93';
  const claim = JSON.stringify({ kind: 'choose', ref: folio, quote, text: '93' });
  const first = [...search(indexPage, folio), ...read(folio, quote)];
  for (const reads of [[], read(indexPage, 'South | effective | count = 27')]) {
    const reply = await replay('Identify the sole effective site.', [...first, ...reads, claim]);
    assert.equal(reply.status, 'waiting');
    assert.deepEqual(reply.report, { kind: 'ask', slot: 'site' });
  }
  const chosen = await replay('Identify the sole effective site.', [...first, ...read(indexPage, 'South | archived | count = 27'), claim]);
  assert.deepEqual(chosen, { status: 'completed', text: '93', report: { kind: 'choose', slot: 'site', ref: folio } });
  const ordinary = await replay('Give the count.', [...search(folio), ...read(folio, quote), '93']);
  assert.deepEqual(ordinary, { status: 'completed', text: '93' });
});
