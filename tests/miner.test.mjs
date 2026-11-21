import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { pack } from '../lib/pack.mjs';
import { canonicalSource, checkSource, sha256 } from '../lib/source.mjs';
import { signedSubmission, submissionIdentity } from '../lib/submission.mjs';
import { roundDigest, weeklyRound } from '../lib/round.mjs';

const kit = fileURLToPath(new URL('../', import.meta.url));
const example = join(kit, 'examples/minimal');
const zero = 'sha256:' + '0'.repeat(64);
const hotkey = '5CaypP6WQssk1JX2ouPkex2EPDwn3X2rv8MEU8juScA6aoqn';
const golden = 'sha256:424d9901e61b68d35d33754c2f86efa6d38dcef397184f18697108d80156d016';
const week2 = 'sha256:731a12db45987c9f3cd29ed1663d35dea3f7fc41d8041abbb5a92337c9913abc';
const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const cli = (args, cwd = kit) => spawnSync(join(kit, 'pocket-miner'), args, { cwd, encoding: 'utf8' });

async function temp(t) {
  const dir = await mkdtemp(join(kit, '.test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('minimal example produces the same flat source, lock and recipe digests offline', async () => {
  const bytes = await pack(zero, example);
  assert.deepEqual(bytes, await pack(zero, example));
  assert.deepEqual(bytes, canonicalSource(bytes));
  assert.equal(sha256(bytes), golden);
  const source = JSON.parse(bytes);
  assert.deepEqual(source.files.map(f => f.path), ['build.mjs', 'harness.mjs']);
  assert.equal(hash(JSON.stringify(source.recipe)), 'sha256:8c9ec77ec56f1da3a0135489ab58248e4b012dda2c1328362ac39b78121d177f');
  assert.equal(hash(JSON.stringify(source.dependencyLock)), 'sha256:008539ef922f0b76fd908bbf568f59e9cbb86007d466579256307636217efbe6');
  assert.throws(() => checkSource(Buffer.from(JSON.stringify(source, null, 2))), /canonical JSON/);
});

test('CLI packs the current or selected project and never overwrites output', async t => {
  const dir = await temp(t);
  const args = ['pack', '--base-image-digest', zero, '--out', join(dir, 'one')];
  const a = cli(args, example);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.stdout.trim(), golden);
  const b = cli([...args.slice(0, -1), 'two', '--project', example], dir);
  assert.equal(b.status, 0, b.stderr);
  assert.equal(b.stdout, a.stdout);
  assert.match(cli(['check', 'two'], dir).stdout, /2 of 32 entries/);
  assert.equal(cli(['digest', 'two'], dir).stdout.trim(), golden);
  assert.match(cli(args, example).stderr, /already exists/);
  assert.equal(hash(await readFile(join(dir, 'one'))), golden);
});

test('tree files and vendored dependencies are deterministic in either declaration order', async t => {
  const dir = await temp(t);
  const dependencies = ['z', '@unit/a'].map(name => ({ name, version: '1.2.3' }));
  const manifest = { format: 'pocket-node-tree-source-v1', entrypoint: 'build.mjs', files: ['build.mjs'], dependencies };
  await writeFile(join(dir, 'build.mjs'), '// build fixture');
  for (const dep of dependencies) {
    const root = 'node_modules/' + dep.name;
    await mkdir(join(dir, root), { recursive: true });
    await writeFile(join(dir, root, 'package.json'), JSON.stringify(dep));
    await writeFile(join(dir, root, 'asset.bin'), Buffer.from([0, 255, 128]));
    manifest.files.push(root + '/package.json', root + '/asset.bin');
  }
  const save = () => writeFile(join(dir, 'pocket.json'), JSON.stringify(manifest));
  await save();
  const first = await pack(zero, dir);
  manifest.files.reverse();
  manifest.dependencies.reverse();
  await save();
  assert.deepEqual(await pack(zero, dir), first);
  assert.deepEqual(canonicalSource(first), first);
  const parsed = JSON.parse(first);
  parsed.files.find(f => f.path.endsWith('/asset.bin')).content = 'YQ==';
  assert.throws(() => canonicalSource(Buffer.from(JSON.stringify(parsed))), /lock mismatch/);
  manifest.dependencies.pop();
  await save();
  await assert.rejects(pack(zero, dir), /outside the locked/);
});

test('explicit files stay inside the project, including through directories', async t => {
  const dir = await temp(t);
  await writeFile(join(dir, 'build.mjs'), '// build fixture');
  await symlink(example, join(dir, 'linked'), 'dir');
  const manifest = { format: 'pocket-node-tree-source-v1', entrypoint: 'build.mjs', files: [] };
  for (const path of ['../package.json', 'linked/harness.mjs', 'build.mjs']) {
    manifest.files = ['build.mjs', path];
    await writeFile(join(dir, 'pocket.json'), JSON.stringify(manifest));
    await assert.rejects(pack(zero, dir), /project-relative|Symlinks|Duplicate/);
  }
});

test('round CLI matches the worked example, including both sides of the cutoff', () => {
  const flags = ['round', '--network', 'test', '--netuid', '1', '--start', '12345', '--length', '50400', '--block'];
  assert.deepEqual(JSON.parse(cli([...flags, '113145']).stdout), { index: 2, id: week2 });
  assert.equal(JSON.parse(cli([...flags, '113144']).stdout).index, 1);
  assert.equal(JSON.parse(cli([...flags, '12345']).stdout).index, 0);
  assert.match(cli([...flags, '12344']).stderr, /not started/);
  assert.throws(() => weeklyRound('test', 1, 0, 0, 1));
  assert.notEqual(weeklyRound('TEST', 1, 12345, 50400, 113145).id, week2);
});

test('round-digest substitutes only the ID and orders the published fields', async t => {
  const dir = await temp(t);
  const record = { id: weeklyRound('test', 1, 12345, 50400, 12345).id, baseImageDigest: zero,
    rootfsDigest: hash('rootfs'), environmentDigest: hash('environment'),
    opensAt: 10, closesAt: 20, maxSubmissions: 3, maxPerMiner: 2 };
  const file = join(dir, 'round.json');
  await writeFile(file, JSON.stringify(Object.fromEntries(Object.entries(record).reverse()), null, 2));
  const expected = hash('pocket-build-round-v1\n' + JSON.stringify({ ...record, id: week2 }));
  assert.equal(cli(['round-digest', '--round-zero', file, '--round-id', week2]).stdout.trim(), expected);
  assert.throws(() => roundDigest({ ...record, maxPerMiner: 4 }, week2));
  assert.throws(() => roundDigest({ ...record, extra: true }, week2));
});

test('commitment binds the source, subnet, round digest and hotkey as Raw67', () => {
  const id = hash('pocket-submission-v2\n' + JSON.stringify([17, hotkey, zero, golden]));
  const identity = submissionIdentity(17, hotkey, zero, golden);
  assert.deepEqual(identity, { id, commitment: 'p1:' + id.slice(7) });
  assert.equal(Buffer.byteLength(identity.commitment, 'ascii'), 67);
  assert.notEqual(submissionIdentity(17, hotkey, week2, golden).id, id);
  assert.throws(() => submissionIdentity(65536, hotkey, zero, golden));
});

test('signer receives the domain-separated request hash and the envelope carries exact source bytes', async () => {
  const source = await pack(zero, example), at = 1700000000000;
  const request = { version: 'pocket-miner-v2', identity: { kind: 'sr25519', hotkey }, netuid: 17, at,
    command: { action: 'submit', roundId: week2, roundDigest: zero, sourceDigest: golden, source: source.toString() } };
  const input = { netuid: 17, hotkey, roundId: week2, round: zero, source, at };
  const signature = Buffer.alloc(64, 0xab); // Fixed signer double, no key material.
  const envelope = await signedSubmission(input, message => {
    assert.deepEqual(message, Buffer.from('pocket-miner-command-v2\n' + hash(JSON.stringify(request))));
    return signature;
  });
  assert.equal(envelope.toString(), JSON.stringify({ request, signature: signature.toString('hex') }));
  await assert.rejects(signedSubmission(input, () => Buffer.alloc(63)), /signature/);
});

test('commit without --allow-writes refuses before any file access or wallet call', () => {
  const result = cli(['commit', '--source', 'absent', '--python', 'missing-interpreter']);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /requires --allow-writes/);
});
