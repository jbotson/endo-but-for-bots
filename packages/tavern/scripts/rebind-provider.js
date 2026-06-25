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
 * Re-bind a tavern agent's driver to a (newly-stored) LLM provider without
 * tearing down and re-creating the agent. History on disk is untouched.
 *
 * The driver's `llm-provider` petstore entry holds a formula identifier
 * captured at `createAgent` time — re-storing the host provider under
 * `default` does NOT update the driver until this script rewrites that
 * entry. After re-binding, restart the daemon so the pinned driver
 * re-evaluates and picks up the new provider config.
 *
 * Prerequisite: the new provider config must already be stored in the host
 * petstore, e.g.:
 *   endo store --json '{"host":"...","model":"...","authToken":"..."}' --name default
 *
 * Usage:
 *   node scripts/rebind-provider.js <agent> [--provider default]
 *
 * Then:
 *   yarn endo stop && yarn endo start
 *
 * For a model-only switch (same host/auth), this script is unnecessary —
 * edit agent.json's `model` (or re-run import-card --model) and restart.
 */
const main = async () => {
  const { flags, _ } = parseArgs(process.argv.slice(2));
  const agentName = _[0];
  if (!agentName) {
    console.error('Usage: rebind-provider <agent> [--provider default]');
    console.error('  Prerequisite: endo store --json \'{"host","model","authToken"}\' --name default');
    process.exit(1);
  }

  const providerName = typeof flags.provider === 'string' ? flags.provider : 'default';
  const driverHandleName = `${agentName}-driver-handle`;
  const driverProfileName = `profile-for-${driverHandleName}`;

  const { reject: cancel, promise: cancelled } = makePromiseKit();
  const { getBootstrap } = await makeEndoClient(
    'tavern-rebind-provider',
    getEndoSockPath(),
    cancelled,
  );
  const bootstrap = getBootstrap();
  const host = await E(bootstrap).host();

  // 1. Identify the host-side provider (must already be stored, e.g. via
  //    `endo store --json ... --name <providerName>`).
  const providerId = /** @type {string} */ (
    await E(host).identify(providerName)
  );

  // 2. Look up the driver guest's EndoGuest and re-store the provider id
  //    under `llm-provider` (storeIdentifier overwrites the prior binding).
  const driverPowers = await E(host).lookup(driverProfileName);
  await E(driverPowers).storeIdentifier('llm-provider', providerId);

  console.log(`[tavern] re-bound agent "${agentName}" to provider "${providerName}"`);
  console.log('  driver llm-provider ->', providerId);
  console.log('  restart the daemon to pick up the new provider: yarn endo stop && yarn endo start');

  cancel(new Error('done'));
  process.exit(0);
};

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
