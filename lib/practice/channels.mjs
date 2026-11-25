// Preloaded only in the child. Keep imports relative to the original harness.
import fs from 'node:fs';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = process.cwd();
const channels = new Map(['activation.json', 'control.sock', 'gateway.sock'].map(name =>
  ['/channels/' + name, join(directory, name)]));
function local(path) {
  const name = path instanceof URL && path.protocol === 'file:' ? fileURLToPath(path) :
    Buffer.isBuffer(path) ? path.toString() : path;
  return channels.get(name) ?? path;
}

for (const api of [fs, fs.promises]) {
  for (const name of ['readFile', 'readFileSync', 'open', 'openSync', 'access', 'accessSync', 'existsSync', 'stat', 'statSync', 'createReadStream']) {
    const original = api[name];
    if (original) api[name] = function(path, ...args) { return original.call(this, local(path), ...args); };
  }
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const options = Array.isArray(args[0]) ? args[0] : args;
  const first = options[0];
  if (channels.has(first)) return connect.call(this, local(first), ...options.slice(1));
  if (channels.has(first?.path)) return connect.call(this, { ...first, path: local(first.path) }, ...options.slice(1));
  return connect.apply(this, args);
};
syncBuiltinESMExports();
