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
 * Grant the scheduling capability (createSchedule / removeSchedule tools) to
 * an existing tavern agent without recreating it.
 *
 * Creates a narrowed `TimerHost` exo (makeTimer / lookup / cancel / remove
 * only — no broader EndoHost access) and stores it as `host-agent` in the
 * driver guest's petstore. After restarting the daemon, the pinned driver
 * picks up the `hostRef` and the schedule tools work.
 *
 * Usage:
 *   node scripts/grant-scheduling.js <agent>
 *
 * Then:
 *   yarn endo stop && yarn endo start
 */
const main = async () => {
  const { _ } = parseArgs(process.argv.slice(2));
  const agentName = _[0];
  if (!agentName) {
    console.error('Usage: grant-scheduling <agent>');
    process.exit(1);
  }

  const driverHandleName = `${agentName}-driver-handle`;
  const driverProfileName = `profile-for-${driverHandleName}`;

  const { reject: cancel, promise: cancelled } = makePromiseKit();
  const { getBootstrap } = await makeEndoClient(
    'tavern-grant-scheduling',
    getEndoSockPath(),
    cancelled,
  );
  const bootstrap = getBootstrap();
  const host = await E(bootstrap).host();

  // `@agent` is the special name for the host's own EndoHost formula ID
  // (NOT `@self`, which resolves to the mailbox Handle — open/receive only).
  // See packages/daemon/src/host.js: '@agent': hostId, '@self': handleId.
  const hostId = await E(host).identify('@agent');

  // Store 'host-agent' in the driver guest's petstore as a formula ID.
  // The driver narrows it with makeTimerHost at lookup time — the agent
  // can't reach it because it's in the DRIVER's petstore, not the agent's.
  const driverPowers = await E(host).lookup(driverProfileName);
  await E(driverPowers).storeIdentifier('host-agent', hostId);

  console.log(`[tavern] granted scheduling capability to agent "${agentName}"`);
  console.log('  driver host-agent -> raw host formula ID (narrowed by driver at startup)');
  console.log('  Security: host-agent is in the driver guest\'s petstore, not the agent\'s.');
  console.log('  The agent cannot lookup("host-agent") from its own powers.');
  console.log('  The driver narrows it to TimerHost (makeTimer/lookup/cancel/remove only).');
  console.log('  Restart the daemon so the pinned driver picks up the new capability:');
  console.log('    yarn endo stop && yarn endo start');

  cancel(new Error('done'));
  process.exit(0);
};

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
