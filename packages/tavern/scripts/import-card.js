// @ts-check
/* eslint-disable no-console */
/* global process */
/**
 * Import a SillyTavern character card into tavern disk state.
 *
 * Usage:
 *   node scripts/import-card.js --card ./Seraphina.png --agent seraphina \
 *     [--state-dir DIR] [--user-name User] [--persona "..."] \
 *     [--no-card-system-prompt] [--include first_mes] \
 *     [--greeting-index 0] [--provider default] [--model null] [--fsync]
 *
 * Writes `<stateDir>/agent.json` + `card.json`; never touches `tree.jsonl`.
 */

import '@endo/init/debug.js';

import { importCard } from '../src/import.js';
import { parseArgs } from './args.js';

const main = async () => {
  const { flags } = parseArgs(process.argv.slice(2));
  const card = /** @type {string} */ (flags.card);
  const agent = /** @type {string} */ (flags.agent);
  if (!card || !agent) {
    console.error('Usage: import-card --card <path> --agent <name> [options]');
    process.exit(1);
  }

  const includeRaw = /** @type {string|undefined} */ (flags.include);
  const include = includeRaw
    ? Object.fromEntries(
        includeRaw.split(',').map(kv => {
          const [k, v] = kv.split('=');
          return [k.trim(), v === undefined ? true : v !== 'false'];
        }),
      )
    : undefined;

  const result = await importCard({
    card,
    agent,
    stateDir: typeof flags['state-dir'] === 'string' ? flags['state-dir'] : undefined,
    userName: typeof flags['user-name'] === 'string' ? flags['user-name'] : undefined,
    personaDescription:
      typeof flags.persona === 'string' ? flags.persona : undefined,
    useCardSystemPrompt: flags['no-card-system-prompt'] !== true,
    include,
    alternateGreetingIndex:
      typeof flags['greeting-index'] === 'string'
        ? Number(flags['greeting-index'])
        : undefined,
    providerName:
      typeof flags.provider === 'string' ? flags.provider : undefined,
    model:
      typeof flags.model === 'string' && flags.model !== 'null'
        ? flags.model
        : null,
    fsync: flags.fsync === true,
  });

  console.log(`[tavern] imported card for "${result.agentName}"`);
  console.log(`  agent:     ${result.agentPath}`);
  console.log(`  card:      ${result.cardPath}`);
  console.log(`  state dir: ${result.stateDir}`);
};

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});