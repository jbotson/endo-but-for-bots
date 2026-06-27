// @ts-check
/* eslint-disable no-console */
/* global process */

import '@endo/init/debug.js';

import { E } from '@endo/far';
import { makePromiseKit } from '@endo/promise-kit';
import { makeEndoClient } from '@endo/daemon';
import os from 'node:os';
import path from 'node:path';

import { parseArgs } from './args.js';

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
 * Grant the tavern-factory capability to an existing agent's driver, so the
 * summarization tools (spawnProbeAgent, commitSummary, discardSummary) can
 * spawn and tear down probe sub-agents.
 *
 * For agents created before the factory-ref wiring was added to createAgent.
 *
 * Usage:
 *   node scripts/grant-factory.js <agent> [--factory tavern-factory]
 *
 * Then:
 *   yarn endo stop && yarn endo start
 */
const main = async () => {
  const { _ } = parseArgs(process.argv.slice(2));
  const agentName = _[0];
  if (!agentName) {
    console.error('Usage: grant-factory <agent> [--factory tavern-factory]');
    process.exit(1);
  }

  const factoryName = 'tavern-factory';
  const driverHandleName = `${agentName}-driver-handle`;
  const driverProfileName = `profile-for-${driverHandleName}`;

  const { reject: cancel, promise: cancelled } = makePromiseKit();
  const { getBootstrap } = await makeEndoClient(
    'tavern-grant-factory',
    getEndoSockPath(),
    cancelled,
  );
  const bootstrap = getBootstrap();
  const host = await E(bootstrap).host();

  // 1. Get the factory's locator from the host's petstore.
  const factoryLocator = await E(host).locate(factoryName);

  // 2. Store it as 'tavern-factory' in the driver guest's petstore.
  const driverPowers = await E(host).lookup(driverProfileName);
  await E(driverPowers).storeLocator('tavern-factory', factoryLocator);

  console.log(`[tavern] granted factory capability to agent "${agentName}"`);
  console.log('  driver tavern-factory ->', factoryLocator);
  console.log('  restart the daemon so the pinned driver picks up the capability:');
  console.log('    yarn endo stop && yarn endo start');

  cancel(new Error('done'));
  process.exit(0);
};

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
