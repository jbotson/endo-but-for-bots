// @ts-check
// endo run --UNCONFINED setup.js --powers @agent

import { E } from '@endo/eventual-send';

/**
 * Provision the Tavern factory guest (the handle whose petstore the
 * tavern-factory caplet will be bound to by `tavern-factory-setup.js`).
 *
 * Idempotent: a restart re-runs `setup`, so guard with `has`.
 *
 * @param {import('@endo/eventual-send').ERef<object>} agent
 */
export const main = async agent => {
  const name = 'tavern-factory-handle';
  const agentName = `profile-for-${name}`;

  const has = await E(agent).has(name);
  if (has) {
    console.log('Tavern factory guest already provisioned — skipping.');
    return;
  }

  await E(agent).provideGuest(name, {
    introducedNames: harden({ '@agent': 'host-agent' }),
    agentName,
  });
  console.log(`Tavern factory guest "${name}" provisioned.`);
};
harden(main);