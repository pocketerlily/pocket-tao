import { checkIdentity } from '../lib/submission.mjs';
import { digest } from '../lib/source.mjs';
import { u16, uint } from './config.mjs';

function bounds(round) {
  return uint(round?.startBlock) && uint(round.endBlock) && round.startBlock <= round.endBlock;
}

function winner(value, netuid) {
  checkIdentity(netuid, value.hotkey);
  digest(value.submissionId);
  return Number.isFinite(value.score) && value.score > 0 && value.score <= 1 && uint(value.commitBlock);
}

function wellFormed(doc) {
  try {
    if (doc?.format !== 'pocket-champions-v1' || typeof doc.network !== 'string' || !doc.network.length ||
        !u16(doc.netuid) || !uint(doc.generatedAt) || !uint(doc.block) ||
        !Number.isFinite(doc.secondsPerBlock) || doc.secondsPerBlock <= 0) return false;
    const { round, champion, history } = doc;
    if (round !== null && !(bounds(round) && uint(round.index) && uint(round.blocksRemaining))) return false;
    if (champion !== null) {
      if (!winner(champion, doc.netuid) || !u16(champion.uid) || !uint(champion.round) || !uint(champion.sinceBlock)) return false;
      digest(champion.sourceDigest);
    }
    return Array.isArray(history) && history.every(entry => bounds(entry) && uint(entry.round) &&
      uint(entry.settledBlock) && uint(entry.submissions) && uint(entry.disqualified) &&
      entry.disqualified <= entry.submissions && (entry.champion === null || winner(entry.champion, doc.netuid)));
  } catch {
    return false;
  }
}

function check(report, name, pass, failure) {
  report.checks[name] = pass;
  if (!pass && report.status === 'ready') report.status = failure;
  return pass;
}

export function checkTime(generatedAt, config, report) {
  const age = Date.now() - generatedAt;
  return check(report, 'fresh', age >= -300_000 && age <= config.maxResultAgeSeconds * 1000,
    age < 0 ? 'result_in_future' : 'result_stale');
}

export function checkDocument(doc, config, report) {
  report.status = 'ready';
  if (!check(report, 'document', wellFormed(doc), 'invalid_document')) return false;
  if (doc.champion) report.champion = { hotkey: doc.champion.hotkey, uid: doc.champion.uid };
  const target = report.champion?.uid ?? config.emptyRoundUid;
  if (target !== undefined) report.weights = [{ uid: target, weight: 65535 }];
  check(report, 'network', doc.network === config.network, 'network_mismatch');
  check(report, 'netuid', doc.netuid === config.netuid, 'netuid_mismatch');
  checkTime(doc.generatedAt, config, report);
  return report.status === 'ready';
}

export function checkSnapshot(s, report) {
  const valid = !!s && typeof s.validatorHotkey === 'string' && /^[1-9A-HJ-NP-Za-km-z]{48}$/.test(s.validatorHotkey) &&
    (s.validatorUid === null || u16(s.validatorUid)) && (s.championUid === null || u16(s.championUid)) &&
    typeof s.validatorPermit === 'boolean' && [s.block, s.epoch, s.tempo, s.lastUpdate, s.rateLimit].every(uint) &&
    u16(s.maxWeight);
  if (!check(report, 'chain', valid, 'chain_unavailable')) return false;
  report.epoch = s.epoch;
  if (report.champion && check(report, 'championRegistered', s.championUid !== null, 'champion_not_registered')) {
    check(report, 'championUid', report.champion.uid === s.championUid, 'champion_uid_mismatch');
  }
  if (check(report, 'validatorRegistered', s.validatorUid !== null, 'validator_not_registered')) {
    check(report, 'validatorPermit', s.validatorPermit, 'validator_permit_required');
  }
  if (report.weights.length) {
    check(report, 'tempo', s.tempo > 0, 'tempo_disabled');
    check(report, 'rateLimit', s.lastUpdate === 0 || s.block - s.lastUpdate >= s.rateLimit, 'rate_limited');
    check(report, 'weightLimit', report.weights[0].uid === s.validatorUid || s.maxWeight === 65535, 'weight_limit');
  }
  return report.status === 'ready';
}
