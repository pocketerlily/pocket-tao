import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export const uint = value => Number.isSafeInteger(value) && value >= 0;
export const u16 = value => uint(value) && value <= 65535;

function walletName(value) {
  return typeof value === 'string' && value.trim() !== '' && !/[/\\\x00]/.test(value) && value !== '.' && value !== '..';
}

export async function readConfig(file) {
  const config = JSON.parse(await readFile(file, 'utf8'));
  const { network, netuid, wallet, resultsUrl, emptyRoundUid,
    allowWrites = false, pollSeconds = 600, maxResultAgeSeconds = 7200 } = config;
  if (typeof network !== 'string' || !network.trim() || !u16(netuid) ||
      (emptyRoundUid !== undefined && !u16(emptyRoundUid)) || typeof allowWrites !== 'boolean' ||
      !uint(pollSeconds) || !pollSeconds || pollSeconds * 1000 > 2 ** 31 - 1 ||
      !uint(maxResultAgeSeconds) || !walletName(wallet?.hotkey) || !walletName(wallet?.name) ||
      typeof wallet.path !== 'string' || !(isAbsolute(wallet.path) || wallet.path.startsWith('~/'))) throw Error();
  if (typeof resultsUrl !== 'string') throw Error();
  const url = new URL(resultsUrl);
  const loopback = /^http:\/\/127\.0\.0\.1:(\d{1,5})(?:[/?#]|$)/.exec(resultsUrl);
  if (url.username || url.password || !(url.protocol === 'https:' ||
      (url.protocol === 'http:' && loopback && Number(loopback[1]) > 0))) throw Error();
  const path = wallet.path.startsWith('~/') ? join(homedir(), wallet.path.slice(2)) : wallet.path;
  return { network, netuid, resultsUrl: url, wallet: { name: wallet.name, hotkey: wallet.hotkey, path },
    allowWrites, pollSeconds, maxResultAgeSeconds, emptyRoundUid };
}
