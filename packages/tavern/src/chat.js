// @ts-check

import harden from '@endo/harden';

/**
 * Parse a SillyTavern chat export (`.jsonl`).
 *
 * Line 1 is a header: `{ user_name, character_name, chat_metadata, ... }`.
 * Every subsequent line is a message:
 *   { name, is_user, is_system, mes, send_date, extra, swipe_id, swipes? }
 *
 * Returns the header plus a linear list of role-tagged messages ready to be
 * appended into a conversation tree.
 *
 * @typedef {object} ChatHeader
 * @property {string} [user_name]
 * @property {string} [character_name]
 * @property {Record<string, unknown>} [chat_metadata]
 */

/**
 * @typedef {object} ParsedChat
 * @property {ChatHeader} header
 * @property {{ role: 'system' | 'user' | 'assistant', name?: string, content: string, send_date?: string }[]} messages
 */

/**
 * @param {string} jsonl - the raw file contents
 * @param {{ keepSystem?: boolean }} [opts] - include `is_system` lines (default false)
 * @returns {ParsedChat}
 */
export const parseChat = (jsonl, opts = {}) => {
  const keepSystem = opts.keepSystem ?? false;
  const lines = jsonl.split('\n').filter(line => line.trim().length > 0);
  if (lines.length === 0) {
    return { header: {}, messages: [] };
  }

  /** @type {ChatHeader} */
  let header = {};
  /** @type {{ role: 'system' | 'user' | 'assistant', name?: string, content: string, send_date?: string }[]} */
  const messages = [];

  const first = JSON.parse(lines[0]);
  const startAtMessage = first && typeof first === 'object' && first.user_name !== undefined && first.is_user === undefined
    ? 1
    : 0;
  if (startAtMessage === 1) {
    header = {
      user_name: first.user_name,
      character_name: first.character_name,
      chat_metadata: first.chat_metadata,
    };
  }

  for (let i = startAtMessage; i < lines.length; i += 1) {
    const entry = JSON.parse(lines[i]);
    if (!entry || typeof entry !== 'object') {
      /* skip non-object lines */
    } else {
      const content = pickSwipe(entry);
      const name =
        typeof entry.name === 'string' ? entry.name : undefined;
      const sendDate =
        typeof entry.send_date === 'string' ? entry.send_date : undefined;

      if (entry.is_system) {
        if (keepSystem) {
          messages.push({ role: 'system', name, content, send_date: sendDate });
        }
      } else if (entry.is_user) {
        messages.push({ role: 'user', name, content, send_date: sendDate });
      } else {
        messages.push({
          role: 'assistant',
          name,
          content,
          send_date: sendDate,
        });
      }
    }
  }

  return { header, messages };
};
harden(parseChat);

/**
 * Pick the active swipe content for an ST message entry. If `swipes` is
 * present and `swipe_id` indexes it, use that; otherwise use `mes`.
 *
 * @param {{ swipes?: string[], swipe_id?: number, mes?: string | null }} entry
 * @returns {string}
 */
const pickSwipe = entry => {
  if (Array.isArray(entry.swipes) && entry.swipes.length > 0) {
    const idx =
      typeof entry.swipe_id === 'number'
        ? Math.min(Math.max(entry.swipe_id, 0), entry.swipes.length - 1)
        : entry.swipes.length - 1;
    const chosen = entry.swipes[idx];
    if (typeof chosen === 'string' && chosen.length > 0) return chosen;
  }
  return typeof entry.mes === 'string'
    ? entry.mes
    : entry.mes === null || entry.mes === undefined
      ? ''
      : String(entry.mes);
};