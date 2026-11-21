import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const localPython = fileURLToPath(new URL('../.venv/bin/python', import.meta.url));
export const defaultPython = existsSync(localPython) ? localPython : 'python3';
const helper = fileURLToPath(new URL('./wallet.py', import.meta.url));

export function walletCall(python, request) {
  return new Promise((resolve, reject) => {
    const proc = execFile(python, ['-IB', helper], { timeout: 120000, killSignal: 'SIGKILL', maxBuffer: 65536 },
      (error, stdout) => {
        if (error) {
          const message = error.code === 'ENOENT' ? 'Python interpreter unavailable' :
            request.method === 'commit' ? 'Commit outcome unknown. Check the chain before retrying.' : 'Wallet helper failed';
          return reject(Error(message));
        }
        // Never forward stderr, a traceback, or an unexpected helper response.
        try {
          const response = JSON.parse(stdout);
          if (typeof response.error === 'string') return reject(Error(response.error));
          if (request.method === 'sign' && /^[a-f0-9]{128}$/.test(response.value)) return resolve(Buffer.from(response.value, 'hex'));
          if (request.method === 'commit' && Object.hasOwn(response.value, 'receipt')) return resolve(response.value);
        } catch {}
        reject(Error('Invalid wallet helper response'));
      });
    proc.stdin.on('error', () => {});
    proc.stdin.end(JSON.stringify(request));
  });
}
