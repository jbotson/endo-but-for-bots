// @ts-nocheck
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

import { spawnTavernLoop, makeTimerHost } from './agent.js';

/**
 * Tavern agent driver caplet.
 *
 * A lightweight caplet that runs the disk-backed inbox/LLM loop for a single
 * tavern agent. The factory creates a tiny guest for it whose namespace holds
 * two capability references written at `createAgent` time:
 *
 *   - `llm-provider`  – the provider config `{ host, model, authToken }`
 *   - `agent`          – the agent's EndoGuest (inbox, mail, petstore, tools)
 *
 * The disk state dir / agent name / provider name arrive via the `env`
 * (`TAVERN_STATE_DIR`, `TAVERN_AGENT_NAME`, `TAVERN_PROVIDER_NAME`) so the
 * driver can reload `agent.json` + `tree.jsonl` each turn.
 *
 * When this formula is pinned (`PINS`), `revivePins()` re-launches it on
 * daemon restart, re-reading the disk tree and resuming — exactly the point
 * of disk persistence.
 *
 * IMPORTANT: `make()` must return immediately without awaiting any remote
 * references. During reincarnation, awaiting lookups on the powers guest can
 * deadlock with the provision chain that is creating this very formula.
 * We fire off the async work and return the Far object synchronously.
 *
 * @param {import('@endo/eventual-send').ERef<object>} powers
 * @param {Promise<object> | object | undefined} context
 * @param {{ env?: Record<string, string> }} [options]
 * @returns {Promise<object>}
 */
export const make = async (powers, context, { env } = {}) => {
  const stateDir = env?.TAVERN_STATE_DIR || '';
  const agentName = env?.TAVERN_AGENT_NAME || 'tavern-agent';
  const providerName = env?.TAVERN_PROVIDER_NAME || 'default';

  const startLoop = async () => {
    const providerConfig = /** @type {{ host: string, model: string, authToken: string }} */ (
      await E(powers).lookup('llm-provider')
    );
    const agentPowers = await E(powers).lookup('agent');
    // tavern-factory is stored by createAgent; may be absent in tests or if
    // the factory was created before this feature. spawnTavernLoop tolerates
    // undefined (summary tools that need it will just return an error).
    let factoryRef;
    try {
      factoryRef = await E(powers).lookup('tavern-factory');
    } catch {
      factoryRef = undefined;
    }
    // host-agent is the raw EndoHost ref, stored by createAgent or
    // grant-scheduling. May be absent in tests or older deployments.
    // Narrow it to TimerHost (makeTimer/lookup/cancel/remove only) so the
    // schedule tools can't reach broader host powers. The agent can't
    // lookup('host-agent') — it's in the DRIVER's petstore, not the agent's.
    let hostRef;
    try {
      const rawHost = await E(powers).lookup('host-agent');
      hostRef = makeTimerHost(rawHost);
    } catch {
      hostRef = undefined;
    }
    await spawnTavernLoop(
      agentPowers,
      context,
      providerConfig,
      stateDir,
      agentName,
      factoryRef,
      hostRef,
    );
  };

  startLoop().catch(error => {
    console.error(
      '[tavern-driver] inbox loop error:',
      error instanceof Error ? error.message : String(error),
    );
  });

  return Far('TavernDriver', {
    /** @returns {string} */
    help() {
      return `Tavern agent driver for "${agentName}" (${providerName}). Runs the disk-backed inbox/LLM loop. Pin to PINS for auto-restart on daemon reboot.`;
    },
  });
};
harden(make);