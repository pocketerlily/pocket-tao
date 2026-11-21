import { createHash } from 'node:crypto';
import { digest, sha256 } from './source.mjs';

export function checkIdentity(netuid, hotkey) {
  if (!Number.isInteger(netuid) || netuid < 0 || netuid > 65535) throw Error('Invalid netuid');
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  if (typeof hotkey !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{48}$/.test(hotkey)) throw Error('Invalid SS58 hotkey');
  let number = 0n;
  for (const char of hotkey) number = number * 58n + BigInt(alphabet.indexOf(char));
  const bytes = Buffer.from(number.toString(16).padStart(70, '0'), 'hex');
  const body = bytes.subarray(0, 33);
  const check = createHash('blake2b512').update('SS58PRE').update(body).digest().subarray(0, 2);
  if (bytes.length !== 35 || bytes[0] !== 42 || !check.equals(bytes.subarray(33))) throw Error('Invalid SS58 hotkey');
}

export function submissionIdentity(netuid, hotkey, round, sourceDigest) {
  checkIdentity(netuid, hotkey);
  const id = sha256('pocket-submission-v2\n' + JSON.stringify([netuid, hotkey, digest(round), digest(sourceDigest)]));
  return { id, commitment: 'p1:' + id.slice(7) };
}

// source is the already validated canonical UTF-8 bundle.
export async function signedSubmission({ netuid, hotkey, roundId, round, source, at = Date.now() }, sign) {
  checkIdentity(netuid, hotkey);
  if (typeof roundId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(roundId)) throw Error('Invalid round ID');
  if (!Number.isSafeInteger(at) || at < 0) throw Error('Invalid timestamp');
  const request = { version: 'pocket-miner-v2', identity: { kind: 'sr25519', hotkey }, netuid, at,
    command: { action: 'submit', roundId, roundDigest: digest(round), sourceDigest: sha256(source), source: source.toString('utf8') } };
  const message = Buffer.from('pocket-miner-command-v2\n' + sha256(JSON.stringify(request)));
  const signature = await sign(message);
  if (!(signature instanceof Uint8Array) || signature.length !== 64) throw Error('Invalid sr25519 signature');
  return Buffer.from(JSON.stringify({ request, signature: Buffer.from(signature).toString('hex') }));
}

export async function postEnvelope(endpoint, bytes, transport = fetch) {
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('Invalid submission endpoint');
  const response = await transport(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: bytes, redirect: 'error', signal: AbortSignal.timeout(120000) });
  await response.body?.cancel();
  if (!response.ok) throw Error('Submission endpoint returned HTTP ' + response.status);
  return response.status;
}
