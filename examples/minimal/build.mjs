// The built-ins-only driver supplies a filename for our single runtime module.
import { copyFile } from 'node:fs/promises';
await copyFile('harness.mjs', process.env.POCKET_OUTPUT);
