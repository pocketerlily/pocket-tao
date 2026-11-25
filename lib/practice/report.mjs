import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sha256 } from '../source.mjs';
import { runCase } from './host.mjs';
import { endpointUrl } from './model.mjs';
import { validId } from './tools.mjs';
import { penalty } from './verdict.mjs';

export function summarize(profile, cases, tasks, models, sourceDigest) {
  const usage = () => ({ modelCalls: 0, modelTokens: 0 });
  const weekly = { profile, ...usage(), models: models.map(name => ({ name, passed: 0, ...usage() })),
    passedByTier: Object.fromEntries(['single', 'distractors', 'multi-hop', 'long-page', 'recall', 'collect'].map(tier => [tier, 0])) };
  const byId = new Map(tasks.map(task => [task.id, task]));
  const side = () => ({ passed: 0, total: 0, notRun: 0 });
  const trust = { danger: side(), benign: side(), models: models.map(name => ({ name, hits: [] })) };
  const hits = [];
  let factCases = 0, factPasses = 0;
  for (const row of cases) {
    const task = byId.get(row.id), index = models.indexOf(row.model);
    const model = weekly.models[index], measured = row.observation?.model;
    for (const metrics of [weekly, model]) {
      metrics.modelCalls += measured?.calls ?? 0;
      metrics.modelTokens += measured?.tokens ?? 0;
    }
    if (row.state !== 'error' && row.rules.length) {
      trust.models[index].hits.push({ task: row.id, rules: row.rules });
      hits.push({ task: task.coordinate ? JSON.stringify(task.coordinate) : row.id, rules: row.rules });
    }
    const errand = task.coordinate?.errand;
    if (errand) {
      trust[errand.side].total++;
      if (row.state === 'passed') trust[errand.side].passed++;
    } else {
      factCases++;
      if (row.state === 'passed') {
        weekly.passedByTier[task.tier]++;
        model.passed++;
        factPasses++;
      }
    }
  }
  const fault = cases.find(row => row.state === 'error');
  if (profile === 'agent-facts-v6') {
    Object.assign(trust, penalty(hits, trust.danger, trust.benign, !fault));
    weekly.trust = trust;
  }
  const error = fault?.error ?? weekly.trust?.reason ?? cases.find(row => row.error)?.error;
  const status = fault ? 'error' : cases.every(row => row.state === 'passed') ? 'passed' : 'failed';
  return { format: 'pocket-miner-self-check-v1', scope: 'local-only', productionEligible: false,
    runner: 'practice', sandbox: false, status, stage: 'complete', sourceDigest, ...(error && { error }),
    ...(!error && factCases > 0 && { score: factPasses / factCases }), cases, weekly };
}

export async function preparePractice({ harness, set, models, modelUrl, keyEnv = 'POCKET_MODEL_KEY', ids, limit, concurrency = 2 }) {
  const endpoint = endpointUrl(modelUrl);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv)) throw Error('Invalid key environment variable name');
  const key = process.env[keyEnv];
  if (!key || /\s/.test(key)) throw Error('Missing or invalid model key');
  if (!models.length || new Set(models).size !== models.length ||
      models.some(name => !/^[\w./:-]{1,256}$/.test(name) || name.includes(key))) throw Error('Invalid model list');
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) throw Error('Concurrency must be between 1 and 8');
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw Error('Limit must be a positive integer');
  if (!['agent-facts-v5', 'agent-facts-v6'].includes(set?.profile) || !Array.isArray(set.tasks)) throw Error('Invalid practice set');
  const available = new Set(set.tasks.map(task => task?.id));
  if (available.size !== set.tasks.length || ids?.some(id => !available.has(id))) throw Error('Invalid task selection');
  const tasks = set.tasks.filter(task => !ids || ids.includes(task.id)).slice(0, limit ?? set.tasks.length);
  if (!tasks.length || tasks.some(task => !validId(task.id) || task.id.includes(key))) throw Error('Invalid task selection');
  for (const task of tasks) {
    const b = task.budgets;
    if (!b || ![b.maxRunMs, b.model?.calls, b.model?.tokens].every(n => Number.isSafeInteger(n) && n > 0) ||
        !Number.isSafeInteger(b.toolCalls) || b.toolCalls < 0) throw Error('Invalid task budgets');
    if (task.tier === 'recall' ? !Array.isArray(task.messages) || task.messages.length !== 9 :
        typeof task.question !== 'string' || !Array.isArray(task.pages)) throw Error('Invalid task material');
  }
  harness = resolve(harness);
  const sourceDigest = sha256(await readFile(harness));
  const jobs = models.flatMap(model => tasks.map(task => ({ model, task })));
  return async function run(onCase, signal) {
    const cases = [];
    let next = 0;
    async function worker() {
      while (!signal?.aborted && next < jobs.length) {
        const index = next++, job = jobs[index];
        let row = await runCase({ ...job, harness, sourceDigest, key, endpoint, signal, trust: set.profile === 'agent-facts-v6' });
        // A provider or harness may echo arbitrary strings in a protocol identifier.
        if (JSON.stringify(row).includes(key)) row = { id: job.task.id, model: job.model, state: 'error',
          error: 'practice_runner_failed', observation: null, rules: [] };
        cases[index] = row;
        onCase?.(row);
      }
    }
    await Promise.all(Array.from({ length: Math.min(jobs.length, concurrency) }, worker));
    if (signal?.aborted) throw Error('Practice interrupted');
    const report = summarize(set.profile, cases, tasks, models, sourceDigest);
    if (JSON.stringify(report).includes(key)) throw Error('Unable to save practice result');
    return report;
  };
}
