import { digest, sha256 } from './source.mjs';

function inRange(n, min, max) {
  return Number.isSafeInteger(n) && n >= min && n <= max;
}

export function weeklyRound(network, netuid, start, length, block) {
  if (typeof network !== 'string' || !network.length || !inRange(netuid, 0, 65535) ||
      !inRange(start, 0, 0xffffffff) || !inRange(length, 1, 2628000) ||
      !inRange(block, 0, Number.MAX_SAFE_INTEGER)) throw Error('Invalid round parameters');
  if (block < start) throw Error('Competition has not started at this block');
  const index = Math.floor((block - start) / length);
  const id = sha256('pocket-weekly-round-v1\n' + JSON.stringify([network, netuid, start, length, index]));
  return { index, id };
}

export function roundDigest(record, roundId) {
  const keys = ['id', 'baseImageDigest', 'rootfsDigest', 'environmentDigest', 'opensAt', 'closesAt', 'maxSubmissions', 'maxPerMiner'];
  if (!record || typeof record !== 'object' || Object.keys(record).length !== keys.length ||
      !keys.every(k => Object.hasOwn(record, k)) || typeof record.id !== 'string' ||
      !/^[a-zA-Z0-9_.:-]{1,128}$/.test(record.id)) throw Error('Invalid round zero record');
  const { baseImageDigest, rootfsDigest, environmentDigest, opensAt, closesAt, maxSubmissions, maxPerMiner } = record;
  if (!inRange(opensAt, 0, Number.MAX_SAFE_INTEGER) || !inRange(closesAt, opensAt + 1, Number.MAX_SAFE_INTEGER) ||
      !inRange(maxSubmissions, 1, 10000) || !inRange(maxPerMiner, 1, maxSubmissions)) throw Error('Invalid round window or quotas');
  const round = { id: digest(roundId), baseImageDigest: digest(baseImageDigest), rootfsDigest: digest(rootfsDigest),
    environmentDigest: digest(environmentDigest), opensAt, closesAt, maxSubmissions, maxPerMiner };
  return sha256('pocket-build-round-v1\n' + JSON.stringify(round));
}
