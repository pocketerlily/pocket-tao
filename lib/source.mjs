import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';

const MiB = 1024 * 1024;
export const tree = { files: 4096, fileBytes: 4 * MiB, totalBytes: 24 * MiB, jsonBytes: 36 * MiB, packages: 512 };
export const flat = { files: 32, fileBytes: 65536, totalBytes: 131072, jsonBytes: 262144, packages: 0 };
export const maxSourceBytes = tree.jsonBytes;
export const sha256 = value => 'sha256:' + createHash('sha256').update(value).digest('hex');

export function digest(value) {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) throw Error('Invalid SHA-256 digest');
  return value;
}

export async function readRegular(path, limit = maxSourceBytes) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await fd.stat();
    if (!stat.isFile()) throw Error('Expected a regular file');
    if (stat.size > limit) throw Error(`File size ${stat.size} bytes exceeds the ${limit}-byte limit`);
    const data = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await fd.read(data, offset, data.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw Error('File changed during read');
    return data.subarray(0, offset);
  } finally {
    await fd.close();
  }
}

function fields(object, keys) {
  if (!object || typeof object !== 'object' || Array.isArray(object) ||
      Object.keys(object).length !== keys.length || !keys.every(key => Object.hasOwn(object, key))) {
    throw Error('Unexpected source format');
  }
}

function compare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function orderedFiles(raw, limits) {
  if (!Array.isArray(raw) || !raw.length || raw.length > limits.files) throw Error(`Expected 1 to ${limits.files} files`);
  const names = new Set(), directories = new Map();
  let total = 0;
  const files = raw.map(file => {
    fields(file, ['path', 'content']);
    const { path, content } = file;
    if (typeof path !== 'string' || path.length > 220) throw Error('Invalid file path');
    if (limits === flat && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,70}\.(mjs|json|txt)$/.test(path)) throw Error('Invalid flat source file path');
    const parts = path.split('/');
    if (limits === tree && parts.some(part => !/^[a-zA-Z0-9_@][a-zA-Z0-9_.@+-]{0,99}$/.test(part) ||
        part.endsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part))) {
      throw Error('Invalid tree source file path');
    }
    const lower = path.toLowerCase();
    if (names.has(lower)) throw Error('Duplicate file path');
    names.add(lower);
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/'), key = dir.toLowerCase();
      if (directories.has(key) && directories.get(key) !== dir) throw Error('Conflicting directory names');
      directories.set(key, dir);
    }
    if (typeof content !== 'string') throw Error('Expected Base64 file content');
    if (content.length > 4 * Math.ceil(limits.fileBytes / 3)) throw Error(`Encoded file exceeds the ${limits.fileBytes}-byte decoded file limit`);
    const bytes = Buffer.from(content, 'base64');
    total += bytes.length;
    if (bytes.length > limits.fileBytes) throw Error(`File size exceeds ${limits.fileBytes} bytes`);
    if (total > limits.totalBytes) throw Error(`Decoded files exceed ${limits.totalBytes} bytes in total`);
    if (bytes.toString('base64') !== content) throw Error('File content must be canonical Base64');
    return { path, content };
  });
  for (const key of directories.keys()) if (names.has(key)) throw Error('File conflicts with directory');
  if (!files.some(f => f.path === 'build.mjs')) throw Error('Missing build.mjs');
  return files.sort((a, b) => compare(a.path, b.path));
}

function treeSource(base, rawFiles, dependencies, packing) {
  const files = orderedFiles(rawFiles, tree), seen = new Set();
  if (!Array.isArray(dependencies) || dependencies.length > tree.packages) throw Error('Expected at most 512 locked packages');
  const packages = dependencies.map(dep => {
    fields(dep, packing ? ['name', 'version'] : ['name', 'version', 'root', 'treeDigest']);
    const { name, version } = dep;
    if (typeof name !== 'string' || !/^(?:@[a-z0-9_-]+\/)?[a-z0-9_-][a-z0-9_.-]{0,99}$/.test(name) ||
        typeof version !== 'string' || version.length > 80 || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/.test(version) ||
        seen.has(name)) throw Error('Invalid dependency');
    seen.add(name);
    const root = 'node_modules/' + name;
    const subtree = files.filter(f => f.path.startsWith(root + '/'))
      .map(f => ({ path: f.path.slice(root.length + 1), content: f.content }));
    const treeDigest = sha256(JSON.stringify(subtree));
    if (!packing && (dep.root !== root || dep.treeDigest !== treeDigest)) throw Error('Dependency lock mismatch');
    const manifest = subtree.find(f => f.path === 'package.json');
    if (!manifest) throw Error('Missing dependency manifest');
    const bytes = Buffer.from(manifest.content, 'base64');
    if (bytes.length > 65536) throw Error('Dependency manifest too large');
    const info = parseJson(bytes);
    if (info?.name !== name || info?.version !== version) throw Error('Dependency manifest mismatch');
    return { name, version, root, treeDigest };
  }).sort((a, b) => compare(a.name, b.name));
  for (const file of files) {
    const parts = file.path.split('/');
    if (parts.slice(1).includes('node_modules') ||
        (parts[0] === 'node_modules' && !packages.some(p => file.path.startsWith(p.root + '/')))) {
      throw Error('File outside the locked dependency closure');
    }
  }
  const source = { format: 'pocket-node-tree-source-v1', platform: 'linux/amd64', baseImageDigest: digest(base),
    recipe: { kind: 'node-tree-build-v1', entrypoint: 'build.mjs' },
    dependencyLock: { kind: 'vendored-node-tree-v1', packages }, files };
  const bytes = Buffer.from(JSON.stringify(source));
  if (bytes.length > maxSourceBytes) throw Error('Source exceeds 36 MiB');
  return bytes;
}

function parseJson(bytes) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw Error('Invalid JSON'); }
}

export function packFlat(base, files) {
  const source = { format: 'pocket-node-source-v1', platform: 'linux/amd64', baseImageDigest: digest(base),
    recipe: { kind: 'node-build-v1', entrypoint: 'build.mjs' }, dependencyLock: { kind: 'node-builtins-only-v1', packages: [] },
    files: Array.from(files, ([path, bytes]) => ({ path, content: bytes.toString('base64') })) };
  return canonicalSource(Buffer.from(JSON.stringify(source)));
}

export function packTree(base, files, dependencies) {
  const encoded = Array.from(files, ([path, bytes]) => ({ path, content: bytes.toString('base64') }));
  return treeSource(base, encoded, dependencies, true);
}

export function canonicalSource(bytes) {
  if (bytes.length > maxSourceBytes) throw Error('Source exceeds 36 MiB');
  const source = parseJson(bytes);
  fields(source, ['format', 'platform', 'baseImageDigest', 'recipe', 'dependencyLock', 'files']);
  fields(source.recipe, ['kind', 'entrypoint']);
  fields(source.dependencyLock, ['kind', 'packages']);
  if (source.platform !== 'linux/amd64' || source.recipe.entrypoint !== 'build.mjs') throw Error('Expected linux/amd64 and a build.mjs entrypoint');
  if (source.format === 'pocket-node-source-v1') {
    if (bytes.length > flat.jsonBytes) throw Error('Flat source JSON exceeds 262144 bytes');
    if (source.recipe.kind !== 'node-build-v1' || source.dependencyLock.kind !== 'node-builtins-only-v1' ||
        !Array.isArray(source.dependencyLock.packages) || source.dependencyLock.packages.length) {
      throw Error('Flat source requires the node-build-v1 recipe and an empty built-ins-only lock');
    }
    return Buffer.from(JSON.stringify({ format: source.format, platform: source.platform, baseImageDigest: digest(source.baseImageDigest),
      recipe: { kind: 'node-build-v1', entrypoint: 'build.mjs' }, dependencyLock: { kind: 'node-builtins-only-v1', packages: [] },
      files: orderedFiles(source.files, flat) }));
  }
  if (source.format !== 'pocket-node-tree-source-v1' || source.recipe.kind !== 'node-tree-build-v1' ||
      source.dependencyLock.kind !== 'vendored-node-tree-v1') throw Error('Unsupported source format, recipe or dependency lock');
  return treeSource(source.baseImageDigest, source.files, source.dependencyLock.packages, false);
}

export function checkSource(bytes) {
  const canonical = canonicalSource(bytes);
  // The miner request parser requires this exact string inside the signed envelope.
  if (!canonical.equals(bytes)) throw Error('The submitted source must use canonical JSON field order, file and package order, and compact encoding');
  const source = JSON.parse(canonical);
  const limits = source.format === 'pocket-node-tree-source-v1' ? tree : flat;
  const sizes = source.files.map(file => Buffer.byteLength(file.content, 'base64'));
  return [
    `Source check passed for ${source.format} (${source.platform}).`,
    `Source JSON uses ${bytes.length} of ${limits.jsonBytes} bytes.`,
    `Files use ${sizes.length} of ${limits.files} entries and ${sizes.reduce((a, b) => a + b, 0)} of ${limits.totalBytes} decoded bytes.`,
    `Largest file uses ${Math.max(...sizes)} of ${limits.fileBytes} bytes.`,
    `Dependency lock verified (${source.dependencyLock.kind}, ${source.dependencyLock.packages.length} of ${limits.packages} packages).`
  ].join('\n');
}
