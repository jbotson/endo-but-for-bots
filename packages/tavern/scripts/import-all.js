// @ts-check
/* eslint-disable no-console */
/* global process */
/**
 * Import a SillyTavern character card AND chat export in one go.
 *
 * Usage:
 *   node scripts/import-all.js --card ./Seraphina.png \
 *     --chat ./seraphina.chat.jsonl --agent seraphina [options]
 *
 * Runs importCard then importChat. By default the chat import seeds a
 * portability root node from the freshly-written `agent.json` system prompt,
 * unless `--system-prompt-file -` disables it.
 */

import '@endo/init/debug.js';

import { importCard, importChat } from '../src/import.js';
import { parseArgs } from './args.js';

const main = async () => {
  const { flags } = parseArgs(process.argv.slice(2));
  const card = /** @type {string} */ (flags.card);
  const chat = /** @type {string | undefined} */ (flags.chat);
  const agent = /** @type {string} */ (flags.agent);
  if (!card || !agent) {
    console.error('Usage: import-all --card <path> --agent <name> [--chat <path>] [options]');
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

  const cardResult = await importCard({
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
    contextBudgetTokens:
      typeof flags['context-budget'] === 'string'
        ? Number(flags['context-budget'])
        : undefined,
    summarizeAtRatio:
      typeof flags['summarize-at'] === 'string'
        ? Number(flags['summarize-at'])
        : undefined,
    summarizeDirective:
      typeof flags['summarize-directive'] === 'string'
        ? flags['summarize-directive']
        : undefined,
    enableSummarization: flags['enable-summarization'] === true,
  });

  if (chat) {
    let root;
    if (flags['system-prompt-file'] === '-') {
      root = undefined;
    } else if (typeof flags['system-prompt-file'] === 'string') {
      const fs = await import('node:fs');
      root = fs.readFileSync(flags['system-prompt-file'], 'utf8');
    } else {
      root = cardResult.systemPrompt;
    }
    const chatResult = await importChat({
      chat,
      agent,
      stateDir: cardResult.stateDir,
      keepSystem: flags['keep-system'] === true,
      replace: flags.replace === true,
      systemPromptRoot: root,
      fsync: flags.fsync === true,
    });
    console.log(`[tavern] imported chat: ${chatResult.messageCount} messages → ${chatResult.treePath}`);
  }

  console.log(`[tavern] import-all complete for "${agent}"`);
  console.log(`  state dir: ${cardResult.stateDir}`);
};

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});