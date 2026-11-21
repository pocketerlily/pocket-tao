import { spawn } from 'node:child_process';
import { canonicalSource, maxSourceBytes, sha256 } from './source.mjs';
import { submissionIdentity } from './submission.mjs';

const hubHost = ['huggingface', 'co'].join('.');
const cdnSuffix = '.hf.co';

export function repoFile(id) {
  return 'pocket/' + id.slice(7) + '.json';
}

export function uploadCommand(args) {
  // The printed command must also work when the output directory needs shell quoting.
  const quote = arg => /^[A-Za-z0-9._/-]+$/.test(arg) ? arg : "'" + arg.replaceAll("'", "'\\''") + "'";
  return ['hf', ...args.map(quote)].join(' ');
}

export async function uploadSource(args) {
  for (const cli of ['hf', 'huggingface-cli']) {
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(cli, args, { stdio: 'ignore' });
        child.once('error', reject);
        child.once('close', code => code === 0 ? resolve() : reject(Error('Upload failed. Check your Hugging Face CLI login and repository write access.')));
      });
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  throw Error('Install the Hugging Face CLI or upload the prepared file by hand.');
}

function downloadBase(testBase) {
  if (testBase === undefined) return new URL('https://' + hubHost);
  const match = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})\/?$/.exec(testBase);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) throw Error('Invalid test download origin');
  return new URL(testBase);
}

function allowedDownload(url, base) {
  if (url.username || url.password) return false;
  if (base.protocol === 'http:') return url.origin === base.origin;
  return url.protocol === 'https:' && (url.hostname === hubHost ||
    url.hostname.endsWith('.' + hubHost) || url.hostname.endsWith(cdnSuffix));
}

export async function verifyRemote({ netuid, hotkey, round, id, repo, baseImageDigest, testBase }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const base = downloadBase(testBase);
    let url = new URL(repo + '/resolve/main/' + repoFile(id), base);
    for (let redirects = 0; allowedDownload(url, base); redirects++) {
      const response = await fetch(url, { redirect: 'manual', credentials: 'omit', signal: controller.signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location || redirects >= 5) return 'unreachable';
        await response.body?.cancel();
        url = new URL(location, url);
        continue;
      }
      if ([401, 403, 404].includes(response.status)) return 'not_public';
      if (!response.ok) return 'unreachable';
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body ?? []) {
        size += chunk.length;
        if (size > maxSourceBytes) return 'invalid';
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks, size);
      try {
        if (!canonicalSource(bytes).equals(bytes) || JSON.parse(bytes).baseImageDigest !== baseImageDigest) return 'invalid';
      } catch {
        return 'invalid';
      }
      const remote = submissionIdentity(netuid, hotkey, round, sha256(bytes));
      return remote.id === id ? 'ok' : 'mismatch';
    }
  } catch {
    // A transport failure, including a timeout while reading, can be retried.
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return 'unreachable';
}
