// @ts-check
/* eslint-disable no-console */
/* global process */
/**
 * Import a SillyTavern chat export into a tavern conversation tree.
 *
 * Usage:
 *   node scripts/import-chat.js --chat ./seraphina.chat.jsonl --agent seraphina \
 *     [--state-dir DIR] [--keep-system] [--replace] \
 *     [--system-prompt-file agent.json|<path>|-] [--fsync]
 *
 * Writes `<stateDir>/tree.jsonl` as a linear chain of conversation nodes.
 */

import '@endo/init/debug.js';

import fs from 'node:fs';
import path from 'node:path';

import { importChat } from '../src/import.js';
import { loadAgent } from '../src/agent-state.js';
import { parseArgs } from './args.js';

const readPromptForRoot = async (flag, stateDir) => {
  if (flag === undefined) return undefined;
  if (flag === 'agent.json') {
    const agentPath = path.join(stateDir, 'agent.json');
    try {
      const agent = await loadAgent(agentPath);
      return agent.systemPrompt;
    } catch {
      return undefined;
    }
  }
  if (flag === '-') return undefined; // explicit "no root"
  return fs.readFileSync(flag, 'utf8');
};

const main = async () => {
  const { flags } = parseArgs(process.argv.slice(2));
  const chat = /** @type {string} */ (flags.chat);
  const agent = /** @type {string} */ (flags.agent);
  if (!chat || !agent) {
    console.error('Usage: import-chat --chat <path> --agent <name> [options]');
    process.exit(1);
  }

  const stateDir =
    typeof flags['state-dir'] === 'string' ? flags['state-dir'] : undefined;
  const systemPromptRoot =
    typeof flags['system-prompt-file'] === 'string'
      ? await readPromptForRoot(flags['system-prompt-file'], stateDir ?? '')
      : undefined;

  // Default: a portability root using agent.json's current system prompt,
  // mirroring §4.1 (the driver never trusts it; agent.json is authoritative).
  let resolvedRoot = systemPromptRoot;
  if (resolvedRoot === undefined && stateDir) {
    resolvedRoot = await readPromptForRoot('agent.json', stateDir);
  }

  const result = await importChat({
    chat,
    agent,
    stateDir,
    keepSystem: flags['keep-system'] === true,
    replace: flags.replace === true,
    systemPromptRoot: resolvedRoot,
    fsync: flags.fsync === true,
  });

  console.log(`[tavern] imported chat for "${agent}"`);
  console.log(`  tree:      ${result.treePath}`);
  console.log(`  messages:  ${result.messageCount}`);
};

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});