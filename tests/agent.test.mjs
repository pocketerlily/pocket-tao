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
