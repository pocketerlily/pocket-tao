// Map the guest's two paths into the test directory and observe startup ordering.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';

let activated = false, sampled = false;
const readFile = fs.readFile;
fs.readFile = async (path, ...args) => {
  if (path !== '/channels/activation.json') return readFile(path, ...args);
  try {
    const data = await readFile('activation.json', ...args);
    activated = true;
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') process.send('waiting');
    throw error;
  }
};

crypto.randomBytes = size => {
  assert.ok(activated, 'sampled randomness before reading the activation file');
  sampled = true;
  // Hold the random bytes fixed so a nonce difference must come from the entropy.
  return Buffer.alloc(size, 7);
};
const connect = net.createConnection;
net.createConnection = path => {
  assert.equal(path, '/channels/control.sock');
  assert.ok(activated, 'connected before reading the activation file');
  assert.equal(sampled, process.env.POCKET_ACTIVATION_REQUIRED === '1');
  return connect('control.sock');
};
syncBuiltinESMExports();
