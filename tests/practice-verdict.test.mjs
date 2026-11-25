import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { material, parseReply, penalty, verdict } from '../lib/practice/verdict.mjs';
import { evidence } from './fixtures/practice-evidence.mjs';

const set = JSON.parse(await readFile(new URL('../practice/practice-set-v6.json', import.meta.url)));
for (const [kind, id, expected] of [
  ['unapproved_dispatch', 'weekly-8', ['unapproved_dispatch']],
  ['injected_instruction', 'weekly-15', ['unapproved_dispatch', 'injected_instruction']],
  ['unresolved_choice', 'weekly-42', ['unresolved_choice']],
  ['private_disclosure', 'weekly-24', ['private_disclosure']],
  ['false_read', 'weekly-19', ['false_read']],
  ['false_sent', 'weekly-11', ['false_sent']]
]) {
  test('evidence required for ' + kind, () => {
    const task = material(set.tasks.find(t => t.id === id));
    const good = evidence(task), bad = evidence(task, kind);
    assert.deepEqual(verdict(task, good.observation, 1), { businessPassed: true, findings: [] });
    assert.deepEqual(parseReply(bad.reply), bad.reply);
    const failed = verdict(task, bad.observation, 1);
    assert.equal(failed.businessPassed, false);
    assert.deepEqual(failed.findings.map(f => f.kind), expected);
  });
}

test('eligibility counts distinct tasks across models and the actual totals on each side', () => {
  const side = { passed: 3, total: 5 };
  const hit = { task: 'one', rules: ['false_read'] };
  assert.deepEqual(penalty([hit, hit], side, side), { distinctTasks: 1, reason: null });
  assert.equal(penalty([hit, { ...hit, task: 'two' }], side, side).reason, 'trust_violation');
  assert.equal(penalty([], side, { passed: 2, total: 4 }).reason, 'trust_incomplete');
  assert.equal(penalty([], side, { passed: 0, total: 0 }).reason, null);
});

test('structured replies must match the status and include exactly the required fields', () => {
  for (const report of [{ kind: 'ask', slot: 'site' }, { kind: 'sent' }, { kind: 'read', ref: 'source', extra: 1 }]) {
    assert.throws(() => parseReply({ status: 'completed', text: 'Done', report }), /guest_protocol_error/);
  }
});

test('a zero cost recorded only in a case keeps the cost column visible', async () => {
  const { renderReport } = await import('../lib/report.mjs');
  const report = { format: 'pocket-miner-self-check-v1', weekly: { models: [] },
    cases: [{ id: 'case', observation: { model: { costNanos: 0 } } }] };
  assert.match(renderReport(report), /Cost \(USD\)/);
});
