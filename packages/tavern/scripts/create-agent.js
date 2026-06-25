// @ts-check
/* eslint-disable no-console */
/* global process */

import '@endo/init/debug.js';

import { E } from '@endo/far';
import { makePromiseKit } from '@endo/promise-kit';
import { makeEndoClient } from '@endo/daemon';
import os from 'node:os';
import path from 'node:path';

import { defaultStateDir } from '../src/names.js';
import { parseArgs } from './args.js';

/** Resolve the daemon socket path (same logic as @endo/where). */
const getEndoSockPath = () => {
  if (process.env.ENDO_SOCK) return process.env.ENDO_SOCK;
  if (process.platform === 'darwin') {
    return path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Endo',
      'captp0.sock',
    );
  }
  if (process.env.XDG_RUNTIME_DIR) {
    return path.join(process.env.XDG_RUNTIME_DIR, 'endo', 'captp0.sock');
  }
  return path.join(os.tmpdir(), `endo-${os.userInfo().username}`, 'captp0.sock');
};

/**
 * Call `TavernFactory.createAgent(name, { stateDir, providerName?, pin })`
 * over the running Endo daemon.
 *
 * Usage:
 *   node scripts/create-agent.js <name> [--state-dir DIR] \
 *     [--provider default] [--pin] [--factory tavern-factory]
 */
const main = async () => {
  const { flags, _ } = parseArgs(process.argv.slice(2));
  const agent = _[0];
  if (!agent) {
    console.error('Usage: create-agent <name> [--state-dir DIR] [--provider default] [--pin] [--factory tavern-factory]');
    process.exit(1);
  }

  const stateDir =
    typeof flags['state-dir'] === 'string'
      ? flags['state-dir']
      : defaultStateDir(agent);
  const providerName =
    typeof flags.provider === 'string' ? flags.provider : undefined;
  const pin = flags.pin === true;
  const factoryName =
    typeof flags.factory === 'string' ? flags.factory : 'tavern-factory';

  const { reject: cancel, promise: cancelled } = makePromiseKit();
  const { getBootstrap } = await makeEndoClient(
    'tavern-create-agent',
    getEndoSockPath(),
    cancelled,
  );
  const bootstrap = getBootstrap();
  const host = await E(bootstrap).host();

  const factory = await E(host).lookup(factoryName);
  const profileName = await E(factory).createAgent(
    agent,
    harden({ stateDir, ...(providerName ? { providerName } : {}), pin }),
  );

  console.log(`[tavern] created agent "${agent}" (profile: ${profileName})`);
  console.log(`  state dir: ${stateDir}`);
  if (pin) console.log('  driver pinned to @pins');

  cancel(new Error('done'));
  process.exit(0);
};

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});