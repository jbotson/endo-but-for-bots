// @ts-check
/* eslint-disable no-await-in-loop */
/* global process, setTimeout */
// endo run --UNCONFINED tavern-factory-setup.js --powers @agent \
//   -E PROVIDER_NAME=default -E FACTORY_NAME=tavern-factory

import { E } from '@endo/eventual-send';

const tavernFactorySpecifier = new URL('agent.js', import.meta.url).href;

/**
 * Resolve a provider's formula id, retrying briefly if it hasn't landed yet
 * (same fallback as fae-factory-setup.js).
 *
 * @param {import('@endo/eventual-send').ERef<object>} agent
 * @param {string} providerName
 * @returns {Promise<string>}
 */
const resolveProvider = async (agent, providerName) => {
  const maxAttempts = 5;
  const delayMs = 1000;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const id = /** @type {string} */ (await E(agent).identify(providerName));
      if (id) return id;
    } catch {
      // Name not found yet; retry.
    }
    if (attempt < maxAttempts) {
      console.log(
        `Provider "${providerName}" not found yet, retrying (${attempt}/${maxAttempts})...`,
      );
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(
    `Provider "${providerName}" not found after ${maxAttempts} attempts. Provision one first (e.g. packages/fae: yarn setup && yarn create-provider).`,
  );
};

/**
 * Bind the tavern factory to a named LLM provider and launch the factory
 * caplet. After this, use `yarn create-agent <name>` to bind a driver to an
 * already-imported on-disk state dir.
 *
 * @param {import('@endo/eventual-send').ERef<object>} agent
 */
export const main = async agent => {
  const providerName = process.env.PROVIDER_NAME || 'default';
  const factoryName = process.env.FACTORY_NAME || 'tavern-factory';
  const guestName = `${factoryName}-handle`;
  const agentName = `profile-for-${guestName}`;

  // Ensure the handle guest exists (setup.js may have been skipped).
  const hasGuest = await E(agent).has(guestName);
  if (!hasGuest) {
    await E(agent).provideGuest(guestName, {
      introducedNames: harden({ '@agent': 'host-agent' }),
      agentName,
    });
  }

  const providerId = await resolveProvider(agent, providerName);

  // Write the provider reference into the factory's petstore.
  // E(agent).identify(...) returns a bare formula id, so use storeIdentifier.
  const factoryPowers = await E(agent).lookup(agentName);
  await E(factoryPowers).storeIdentifier('llm-provider', providerId);

  // Launch the tavern-factory caplet.
  await E(agent).makeUnconfined('@main', tavernFactorySpecifier, {
    powersName: agentName,
    resultName: factoryName,
  });

  console.log(
    `Tavern factory "${factoryName}" created, bound to provider "${providerName}".`,
  );
  console.log(
    `Import a character + chat (see scripts/import-all.js), then: yarn create-agent <name> --pin`,
  );
};
harden(main);