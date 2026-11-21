import { mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../lib/source.mjs';

export async function allocate(config, command, snapshot, report, submit) {
  const write = command === 'run' && config.allowWrites;
  const directory = join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'pocket-validator');
  const file = join(directory, 'epochs.sqlite');
  const key = sha256(JSON.stringify([config.network, config.netuid, snapshot.validatorHotkey, snapshot.epoch]));
  const preview = { ...report, status: config.allowWrites ? 'ready' : 'writes_disabled', wouldWrite: config.allowWrites };
  if (write) mkdirSync(directory, { recursive: true, mode: 0o700 });
  else if (!statSync(file, { throwIfNoEntry: false })) return preview;

  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: !write, timeout: 5000 });
  try {
    if (write) db.exec('CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, submitted INTEGER NOT NULL)');
    const previous = db.prepare('SELECT submitted FROM attempts WHERE id=?').get(key);
    if (previous) return { ...report, status: previous.submitted ? 'already_submitted' : 'outcome_unknown' };
    if (!write) return preview;

    // Commit the claim before invoking the signer. A crash or lost reply leaves it in place.
    const claim = db.prepare('INSERT OR IGNORE INTO attempts VALUES (?,0)').run(key);
    if (!claim.changes) return { ...report, status: 'epoch_claimed' };
    const response = await submit();
    const status = response.error ?? (response.value === 'submitted' ? 'submitted' : 'outcome_unknown');
    if (status === 'submitted') db.prepare('UPDATE attempts SET submitted=1 WHERE id=?').run(key);
    if (status === 'submitted' || status === 'outcome_unknown') return { ...report, status, wouldWrite: true };
    db.prepare('DELETE FROM attempts WHERE id=?').run(key);
    const condition = { result_stale: 'fresh', result_in_future: 'fresh', rate_limited: 'rateLimit',
      validator_not_registered: 'validatorRegistered', validator_permit_required: 'validatorPermit' }[status] ?? 'chain';
    return { ...report, status, checks: { ...report.checks, [condition]: false } };
  } finally {
    db.close();
  }
}
