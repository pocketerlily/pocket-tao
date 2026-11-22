// Developer-only. Imports trusted code from the supplied checkouts. The CLI, the
// minimal guest and npm test have no dependency on this script or either checkout.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { pack, packProject } from '../lib/pack.mjs';
import { roundDigest, weeklyRound } from '../lib/round.mjs';
import { sha256 } from '../lib/source.mjs';
import { signedSubmission, submissionIdentity } from '../lib/submission.mjs';

const { values } = parseArgs({ options: { platform: { type: 'string' }, baseline: { type: 'string' },
  'base-image-digest': { type: 'string' } } });
if (!values.platform) throw Error('Usage: node scripts/conformance.mjs --platform PATH [--baseline PATH] [--base-image-digest DIGEST]');
const platform = resolve(values.platform);
const url = (dir, name) => pathToFileURL(join(dir, name)).href;
const miner = await import(url(platform, 'packages/miner/src/index.ts'));
const { parseSource } = await import(url(platform, 'packages/build/src/source.ts'));
const { hotkeyAddress } = await import(url(platform, 'packages/chain/src/port.ts'));
const base = values['base-image-digest'] ?? 'sha256:' + '0'.repeat(64);
let passed = 0;
function pass(label) {
  passed++;
  console.log('PASS ' + label);
}
function same(label, actual, expected) {
  // Avoid echoing guest source or a request envelope if comparison fails.
  assert.ok(actual.equals(expected), label + ' differs: ' + sha256(actual) + ' vs ' + sha256(expected));
  pass(label + ' ' + sha256(actual));
}

// Use the committed schedule as the oracle even during unrelated validator edits.
const roundsPath = 'packages/validator/src/rounds.ts';
const roundsURL = url(platform, roundsPath);
const committed = execFileSync('git', ['-C', platform, 'show', 'HEAD:' + roundsPath], { encoding: 'utf8' });
const snapshot = registerHooks({ load(moduleURL, context, next) {
  if (moduleURL === roundsURL) return { shortCircuit: true, format: 'module-typescript', source: committed };
  return next(moduleURL, context);
} });
let oracle;
try { oracle = await import(roundsURL); }
finally { snapshot.deregister(); }

// Read the same flat input files independently of the kit's manifest reader.
const project = fileURLToPath(new URL('../examples/minimal/', import.meta.url));
const source = await pack(base, project);
const reference = miner.packSource(base, { 'harness.mjs': await readFile(join(project, 'harness.mjs')),
  'build.mjs': await readFile(join(project, 'build.mjs')) });
same('flat packSource bytes', source, reference);
function admission(label, bytes) {
  const parsed = parseSource(bytes);
  assert.ok(parsed.bytes.equals(bytes));
  assert.equal(parsed.sourceDigest, sha256(bytes));
  assert.equal(parsed.dependencyLockDigest, sha256(JSON.stringify(parsed.source.dependencyLock)));
  assert.equal(parsed.recipeDigest, sha256(JSON.stringify(parsed.source.recipe)));
  pass(label);
}
admission('minimal bundle admitted with matching source, recipe and lock digests', source);

const { waitForActivationMarker } = await import(url(platform, 'packages/sandbox/src/activation.ts'));
const guest = spawn(process.execPath, [join(project, 'harness.mjs')], {
  env: { POCKET_ACTIVATION_REQUIRED: '1' }, stdio: ['ignore', 'pipe', 'pipe']
});
const closed = once(guest, 'close');
try {
  await waitForActivationMarker(guest, 'minimal', AbortSignal.timeout(5000));
  pass('platform recognizes the minimal guest standby signal');
} finally {
  guest.kill();
  await closed;
}

// Include binary bytes, two packages and out-of-order paths. This test works
// without a pre-existing install tree, any provisioning profile or a build host.
const dependencies = [{ name: 'z', version: '2.0.0' }, { name: '@kit/a', version: '1.0.0' }];
const tree = new Map([['src/asset.bin', Buffer.from([0, 128, 255])], ['build.mjs', Buffer.from('// recipe fixture')]]);
for (const dep of dependencies) tree.set('node_modules/' + dep.name + '/package.json', Buffer.from(JSON.stringify(dep)));
const treeProject = { format: 'pocket-node-tree-source-v1', entrypoint: 'build.mjs', dependencies, files: [...tree.keys()] };
const treeBytes = await packProject(base, treeProject, path => tree.get(path));
same('vendored packTreeSource bytes', treeBytes, miner.packTreeSource(base, Object.fromEntries(tree), dependencies));
admission('vendored bundle admitted with matching digests', treeBytes);

const params = ['test', 1, 12345, 100800];
const schedule = oracle.roundSchedule({ network: params[0], netuid: params[1], roundStartBlock: params[2], roundBlocks: params[3] });
for (const block of [12345, 113144, 113145, 213945]) {
  const index = oracle.roundIndex(schedule, block);
  assert.deepEqual(weeklyRound(...params, block), { index, id: oracle.buildRoundId(schedule, index) });
}
const { id } = weeklyRound(...params, 213945);
assert.equal(id, 'sha256:1b2ec6531cec24bf520d771449de9204eaa86b25e01abab6be2b30168c8eeb4f');
pass('round index and ID at four block boundaries');
const zero = { id: oracle.buildRoundId(schedule, 0), baseImageDigest: base, rootfsDigest: sha256('root'),
  environmentDigest: sha256('environment'), opensAt: 0, closesAt: 2000000000000, maxSubmissions: 3, maxPerMiner: 1 };
const round = { ...zero, id }, roundHash = roundDigest(zero, id);
assert.equal(roundHash, miner.roundDigest(round));
pass('build round digest from round zero');

// Compare exact request and signing bytes, independently of randomized sr25519 signatures.
const netuid = 1, hotkey = hotkeyAddress(Buffer.alloc(32, 23)), at = 1700000000000;
const identity = submissionIdentity(netuid, hotkey, roundHash, sha256(source));
assert.equal(identity.id, miner.hotkeySubmissionId(netuid, hotkey, roundHash, sha256(reference)));
assert.equal(identity.commitment, miner.commitmentPayload(identity.id));
pass('submission ID and Raw commitment');
if (typeof miner.commitmentPayloadHf === 'function') {
  const repo = 'alice/pocket-harness';
  const p2 = submissionIdentity(netuid, hotkey, roundHash, sha256(source), repo);
  assert.equal(p2.commitment, miner.commitmentPayloadHf(identity.id, repo));
  pass('p2 Hugging Face commitment');
} else {
  console.log('skipped p2 commitment comparison (platform helper unavailable)');
}
let signed;
const sign = message => createHash('sha512').update(message).digest();
const client = new miner.MinerClient(hotkey, { kind: 'sr25519', hotkey, netuid,
  async sign(message) { signed = Buffer.from(message); return sign(message); } }, async bytes => bytes, () => at);
const envelope = await client.submit(round, reference);
const actual = await signedSubmission({ netuid, hotkey, roundId: id, round: roundHash, source, at }, message => {
  assert.ok(message.equals(signed));
  return sign(message);
});
same('signing preimage and complete envelope (test signer)', actual, envelope);

if (values.baseline) {
  // Compare two encoders after the external project's own source preparation.
  // Capture its pre-encoding virtual file tree; never decode the expected
  // bundle to manufacture inputs, execute its guest, or stage files on disk.
  const dir = resolve(values.baseline);
  const packURL = url(dir, 'lib/pack.mjs');
  const encoderURL = url(dir, 'lib/source.mjs');
  const original = await import(packURL);
  const expected = await original.pack(base, dir);

  // Reimport the preparation module with just its final packTree call redirected.
  // All archive processing and input selection remain in the external checkout.
  const probeURL = packURL + '?prepared-inputs';
  const adapter = 'export * from ' + JSON.stringify(encoderURL) +
    '; export function packTree(base, files, dependencies) { return { files, dependencies }; }';
  const hook = registerHooks({ resolve(specifier, context, next) {
    const target = next(specifier, context);
    if (context.parentURL === probeURL && target.url === encoderURL) {
      return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(adapter) };
    }
    return target;
  } });
  let prepare;
  try { prepare = (await import(probeURL)).pack; }
  finally { hook.deregister(); }
  const prepared = await prepare(base, dir);
  const manifest = { format: 'pocket-node-tree-source-v1', entrypoint: 'build.mjs',
    files: [...prepared.files.keys()], dependencies: prepared.dependencies };
  const candidate = await packProject(base, manifest, path => prepared.files.get(path));
  same('external project (' + manifest.files.length + ' files, ' + manifest.dependencies.length + ' packages)', candidate, expected);
  console.log('Compared at base ' + base);
}

console.log(passed + ' checks passed');
