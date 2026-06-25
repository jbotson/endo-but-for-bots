// @ts-check

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import harden from '@endo/harden';

/**
 * Load and parse a small JSON state file. Returns `null` if the file is
 * missing (callers treat that as "fresh"); rethrows parse/read errors.
 *
 * @param {string} filePath
 * @returns {Promise<object | null>}
 */
export const loadJson = async filePath => {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return text.trim().length === 0 ? null : JSON.parse(text);
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code === 'ENOENT') return null;
    throw error;
  }
};
harden(loadJson);

/**
 * Atomically-ish write a small JSON file: write to `<path>.tmp` then rename.
 * Pretty-printed with a trailing newline so `agent.json` stays hand-editable.
 *
 * @param {string} filePath
 * @param {unknown} value
 * @returns {Promise<void>}
 */
export const saveJson = async (filePath, value) => {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, filePath);
};
harden(saveJson);

/**
 * @typedef {object} AgentJson
 * @property {number} schemaVersion
 * @property {string} agentName
 * @property {string} characterName
 * @property {string} userName
 * @property {string} personaDescription
 * @property {string} systemPrompt
 * @property {string} postHistoryInstructions
 * @property {{ depth: number, role: 'system' | 'user' | 'assistant', prompt: string } | null} depthPrompt
 * @property {{ include: Record<string, boolean>, useCardSystemPrompt: boolean, alternateGreetingIndex: number }} promptInputs
 * @property {string} promptHash
 * @property {{ name: string }} provider
 * @property {string | null} model
 * @property {string} importedAt
 * @property {string} [cardPath]
 * @property {string} [chatPath]
 * @property {boolean} fsync
 */

/**
 * @typedef {object} StateJson
 * @property {number} schemaVersion
 * @property {number} lastProcessedMessageNumber
 */

const STATE_SCHEMA_VERSION = 1;

/**
 * Load `state.json` (bookkeeping). Missing ⇒ fresh agent.
 *
 * @param {string} statePath
 * @returns {Promise<StateJson>}
 */
export const loadState = async statePath => {
  const state = await loadJson(statePath);
  if (!state) {
    return { schemaVersion: STATE_SCHEMA_VERSION, lastProcessedMessageNumber: 0 };
  }
  if (state.lastProcessedMessageNumber == null) {
    state.lastProcessedMessageNumber = 0;
  }
  return state;
};
harden(loadState);

/**
 * @param {string} statePath
 * @param {Partial<StateJson>} partial
 * @returns {Promise<void>}
 */
export const saveState = async (statePath, partial) => {
  const state = {
    schemaVersion: STATE_SCHEMA_VERSION,
    lastProcessedMessageNumber: partial.lastProcessedMessageNumber ?? 0,
  };
  await saveJson(statePath, state);
};
harden(saveState);

/**
 * Load `agent.json`. Throws if missing/unreadable — callers (the driver)
 * surface a helpful error to the user ("run the importer").
 *
 * @param {string} agentPath
 * @returns {Promise<AgentJson>}
 */
export const loadAgent = async agentPath => {
  const agent = await loadJson(agentPath);
  if (!agent) {
    throw new Error(
      `Missing or empty agent.json at ${path.basename(
        agentPath,
      )}. Run the importer first.`,
    );
  }
  return agent;
};
harden(loadAgent);

/**
 * Append a line to the import audit log.
 *
 * @param {string} logPath
 * @param {Record<string, unknown>} entry
 * @returns {Promise<void>}
 */
export const appendImportLog = async (logPath, entry) => {
  const dir = path.dirname(logPath);
  await fs.mkdir(dir, { recursive: true });
  const line = `${JSON.stringify({ ...entry, ts: new Date().toISOString() })}\n`;
  const fh = await fs.open(logPath, 'a');
  try {
    await fh.writeFile(line);
  } finally {
    await fh.close();
  }
};
harden(appendImportLog);

/**
 * SHA-1 of the resolved system prompt, used only as an informational
 * audit/correlation hash in `agent.json`. Never used to detect changes
 * and recreate the agent — prompt updates rewrite `agent.json` instead.
 *
 * @param {string} systemPrompt
 * @returns {string}
 */
export const hashPrompt = systemPrompt => {
  const h = crypto.createHash('sha1');
  h.update(systemPrompt);
  return `sha1:${h.digest('hex')}`;
};
harden(hashPrompt);