import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { digest, flat, tree, packFlat, packTree, readRegular } from './source.mjs';

// A project lists the final source paths explicitly, including any prepared dependencies.
// Taking a reader here also lets developer checks compare two packers on the same virtual tree.
export async function packProject(base, manifest, read) {
  digest(base);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) ||
      Object.keys(manifest).some(k => !['format', 'entrypoint', 'files', 'dependencies'].includes(k))) {
    throw Error('Invalid pocket.json');
  }
  const limits = manifest.format === 'pocket-node-source-v1' ? flat : tree;
  if (limits === tree && manifest.format !== 'pocket-node-tree-source-v1') throw Error('Unknown project format');
  if (manifest.entrypoint !== 'build.mjs') throw Error('Expected build.mjs entrypoint');
  const dependencies = Object.hasOwn(manifest, 'dependencies') ? manifest.dependencies : [];
  if (!Array.isArray(dependencies) || dependencies.length > limits.packages) throw Error('Invalid dependency list');
  if (!Array.isArray(manifest.files) || !manifest.files.includes(manifest.entrypoint) || manifest.files.length > limits.files) {
    throw Error('Expected a file list including build.mjs within the format limit');
  }
  const files = new Map();
  let total = 0;
  for (const path of manifest.files) {
    if (typeof path !== 'string' || path.length > 220 ||
        !path.split('/').every(part => /^[a-zA-Z0-9_@][a-zA-Z0-9_.@+-]{0,99}$/.test(part))) {
      throw Error('Expected portable project-relative file paths');
    }
    if (files.has(path)) throw Error('Duplicate project file');
    const bytes = await read(path, Math.min(limits.fileBytes, limits.totalBytes - total));
    total += bytes.length;
    if (bytes.length > limits.fileBytes || total > limits.totalBytes) throw Error('Project exceeds file size limits');
    files.set(path, bytes);
  }
  return limits === flat ? packFlat(base, files) : packTree(base, files, dependencies);
}

export async function pack(base, project = process.cwd()) {
  const root = await realpath(project);
  const manifest = JSON.parse(await readRegular(join(root, 'pocket.json'), 2 * 1024 * 1024));
  return packProject(base, manifest, async (path, limit) => {
    const file = join(root, path);
    if (await realpath(file) !== file) throw Error('Symlinks are not supported in project files');
    return readRegular(file, limit);
  });
}
