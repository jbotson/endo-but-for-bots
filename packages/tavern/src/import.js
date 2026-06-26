// @ts-check
/* eslint-disable no-await-in-loop */

import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';

import harden from '@endo/harden';
import { makeConversationTree } from '@endo/conversation-tree';

import { parseCardFile } from './card.js';
import { resolvePrompt } from './prompt.js';
import { parseChat } from './chat.js';
import { makeDiskBackend } from './disk-backend.js';
import { saveJson, appendImportLog, hashPrompt, CONTEXT_DEFAULTS } from './agent-state.js';
import { validateAgentName, defaultStateDir } from './names.js';

/**
 * @typedef {object} ImportCardOptions
 * @property {string} card - path to the card (.png or .json)
 * @property {string} agent - agent name (used as the on-disk subdir)
 * @property {string} [stateDir] - override the resolved state directory
 * @property {string} [userName] - override the chat header / card's `user_name`
 * @property {string} [personaDescription] - persona injected as `{{persona}}`
 * @property {boolean} [useCardSystemPrompt] - default true
 * @property {number} [alternateGreetingIndex]
 * @property {Partial<{ description: boolean, personality: boolean, scenario: boolean, mes_example: boolean, first_mes: boolean, post_history_instructions: boolean, depth_prompt: boolean }>} [include]
 * @property {string} [providerName] - which stored llm-provider (default "default")
 * @property {string | null} [model] - optional provider model override
 * @property {boolean} [fsync]
 * @property {number} [contextBudgetTokens] - approximate token budget (default 100000)
 * @property {number} [summarizeAtRatio] - fraction of budget to trigger summarization (default 0.75)
 * @property {string} [summarizeDirective] - configurable budget-directive text with `{{estTokens}}`/`{{budgetTokens}}` placeholders
 * @property {boolean} [enableSummarization] - enable summarization tools + budget directive (default false)
 */

/**
 * @typedef {object} ImportCardResult
 * @property {string} stateDir
 * @property {string} agentPath
 * @property {string} cardPath
 * @property {string} agentName
 * @property {string} characterName
 * @property {string} systemPrompt
 */

/**
 * Import (or re-import) a SillyTavern character card into disk state.
 *
 * Writes `agent.json` (resolved, editable config) and `card.json` (the raw
 * card verbatim). **Never touches `tree.jsonl`** — this is the single most
 * important property: editing the card + re-importing changes the live system
 * prompt for the *existing* agent, preserving all history.
 *
 * @param {ImportCardOptions} opts
 * @returns {Promise<ImportCardResult>}
 */
export const importCard = async opts => {
  const agentName = validateAgentName(opts.agent);
  const stateDir = opts.stateDir || defaultStateDir(agentName);

  const card = await parseCardFile(opts.card);
  const characterNameRaw = card.name || 'Character';
  const characterName = characterNameRaw;
  const userName = opts.userName || 'User';
  const personaDescription = opts.personaDescription || '';

  const include = opts.include || {
    description: true,
    personality: true,
    scenario: true,
    mes_example: true,
    first_mes: false,
    post_history_instructions: true,
    depth_prompt: true,
  };

  const { systemPrompt, postHistoryInstructions, depthPrompt } = resolvePrompt(
    card,
    { characterName, userName, personaDescription },
    {
      include,
      useCardSystemPrompt: opts.useCardSystemPrompt ?? true,
      alternateGreetingIndex: opts.alternateGreetingIndex ?? 0,
    },
  );

  const agentPath = path.join(stateDir, 'agent.json');
  const cardPath = path.join(stateDir, 'card.json');
  const logPath = path.join(stateDir, 'imports.log');

  const agentJson = harden({
    schemaVersion: 1,
    agentName,
    characterName,
    userName,
    personaDescription,
    systemPrompt,
    postHistoryInstructions,
    depthPrompt,
    promptInputs: {
      include,
      useCardSystemPrompt: opts.useCardSystemPrompt ?? true,
      alternateGreetingIndex: opts.alternateGreetingIndex ?? 0,
    },
    promptHash: hashPrompt(systemPrompt),
    provider: { name: opts.providerName || 'default' },
    model: opts.model ?? null,
    importedAt: new Date().toISOString(),
    cardPath: path.resolve(opts.card),
    chatPath: undefined,
    fsync: opts.fsync ?? false,
    contextBudgetTokens: opts.contextBudgetTokens ?? CONTEXT_DEFAULTS.contextBudgetTokens,
    summarizeAtRatio: opts.summarizeAtRatio ?? CONTEXT_DEFAULTS.summarizeAtRatio,
    summarizeDirective: opts.summarizeDirective ?? CONTEXT_DEFAULTS.summarizeDirective,
    enableSummarization: opts.enableSummarization ?? CONTEXT_DEFAULTS.enableSummarization,
  });

  await saveJson(agentPath, agentJson);
  // `card.json` is the raw card verbatim (audit / future re-import).
  await saveJson(cardPath, card.raw);

  await appendImportLog(logPath, {
    kind: 'card',
    agent: agentName,
    character: characterName,
    cardPath: agentJson.cardPath,
    specVersion: card.specVersion,
    format: card.format,
    promptHash: agentJson.promptHash,
  });

  return harden({
    stateDir,
    agentPath,
    cardPath,
    agentName,
    characterName,
    systemPrompt,
  });
};
harden(importCard);

/**
 * @typedef {object} ImportChatOptions
 * @property {string} chat - path to the SillyTavern `.jsonl` chat export
 * @property {string} agent - agent name (on-disk subdir)
 * @property {string} [stateDir]
 * @property {boolean} [keepSystem] - include `is_system` messages (default false)
 * @property {boolean} [replace] - overwrite an existing `tree.jsonl` (default false; warns)
 * @property {string} [systemPromptRoot] - optional system root node for portability (§4.1)
 * @property {string} [userName]
 * @property {boolean} [fsync]
 */

/**
 * @typedef {object} ImportChatResult
 * @property {string} stateDir
 * @property {string} treePath
 * @property {number} messageCount
 */

/**
 * Import a SillyTavern `.jsonl` chat export into `tree.jsonl` as a linear
 * chain of conversation-tree nodes. A root node carrying (optionally) the
 * import-time system prompt is recorded first for portability; the driver
 * **never** trusts it as the live prompt (`agent.json` is authoritative).
 *
 * @param {ImportChatOptions} opts
 * @returns {Promise<ImportChatResult>}
 */
export const importChat = async opts => {
  const agentName = validateAgentName(opts.agent);
  const stateDir = opts.stateDir || defaultStateDir(agentName);
  const treePath = path.join(stateDir, 'tree.jsonl');
  const logPath = path.join(stateDir, 'imports.log');

  const text = fs.readFileSync(opts.chat, 'utf8');
  const { header, messages } = parseChat(text, {
    keepSystem: opts.keepSystem ?? false,
  });

  if (fs.existsSync(treePath) && !opts.replace) {
    console.warn(
      `[tavern] ${treePath} already exists; pass --replace to overwrite. Skipping chat import.`,
    );
    return harden({ stateDir, treePath, messageCount: 0 });
  }

  // Start a fresh tree file (replace semantics or new file).
  await fsp.writeFile(treePath, '', 'utf8');

  const backend = await makeDiskBackend(treePath, { fsync: opts.fsync ?? false });
  const tree = makeConversationTree(backend);

  // Optional root node for portability only (the driver reads agent.json).
  let parentId = null;
  if (opts.systemPromptRoot) {
    const root = await tree.addNode(null, [
      { role: 'system', content: opts.systemPromptRoot },
    ]);
    parentId = root.id;
  }

  let count = 0;
  for (const msg of messages) {
    const node = await tree.addNode(
      parentId,
      [{ role: msg.role, content: msg.content }],
      {
        st: {
          name: msg.name,
          send_date: msg.send_date,
        },
      },
    );
    parentId = node.id;
    count += 1;
  }

  await appendImportLog(logPath, {
    kind: 'chat',
    agent: agentName,
    chatPath: path.resolve(opts.chat),
    headerUserName: header.user_name,
    headerCharacterName: header.character_name,
    messageCount: count,
    replace: Boolean(opts.replace),
  });

  return harden({ stateDir, treePath, messageCount: count });
};
harden(importChat);