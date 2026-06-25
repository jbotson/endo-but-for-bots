// @ts-check

import harden from '@endo/harden';

import { resolveMacros } from './macros.js';

/**
 * @typedef {object} IncludeFlags
 * @property {boolean} [description]
 * @property {boolean} [personality]
 * @property {boolean} [scenario]
 * @property {boolean} [mes_example]
 * @property {boolean} [first_mes]
 * @property {boolean} [post_history_instructions]
 * @property {boolean} [depth_prompt]
 */

/**
 * @typedef {object} DepthPrompt
 * @property {number} depth
 * @property {'system' | 'user' | 'assistant'} role
 * @property {string} prompt
 */

/**
 * @typedef {object} ResolvedPrompt
 * @property {string} systemPrompt
 * @property {string} postHistoryInstructions
 * @property {DepthPrompt | null} depthPrompt
 */

/**
 * The fallback string substituted for `{{original}}` in the card's own
 * `system_prompt`. This mirrors ST, which uses a sane default when the
 * author wrote `{{original}}` but no body was supplied.
 */
const FALLBACK_ORIGINAL = `You are {{char}}. Respond in character.`;

const str = v => (typeof v === 'string' ? v : v == null ? '' : String(v));

/**
 * Optionally bracket a labeled section so the assembled prompt is readable.
 *
 * @param {string} label
 * @param {string} body
 * @returns {string}
 */
const section = (label, body) => {
  const trimmed = body.trim();
  if (!trimmed) return '';
  return `[${label}]\n${trimmed}\n`;
};

/**
 * Resolve the usable prompt components from a normalized SillyTavern card.
 *
 * 1. Base system prompt:
 *    - if `data.system_prompt` is non-empty AND `useCardSystemPrompt`: use it,
 *      substituting `{{original}}` for the fallback.
 *    - else assemble from the fields enabled by `include`.
 * 2. post_history_instructions: resolved + returned for ephemeral injection.
 * 3. depth_prompt: from `data.extensions.depth_prompt`.
 *
 * Macros (`{{char}}`, `{{user}}`, `{{original}}`, `{{persona}}`) are expanded
 * in every resolved string.
 *
 * @param {{ data: object }} card - normalized card (`data` is the V2 shape)
 * @param {{ characterName: string, userName: string, personaDescription?: string }} naming
 * @param {{ include?: Partial<IncludeFlags>, useCardSystemPrompt?: boolean, alternateGreetingIndex?: number }} [opts]
 * @returns {ResolvedPrompt}
 */
export const resolvePrompt = (card, naming, opts = {}) => {
  const data = card.data || {};
  const characterName = naming.characterName;
  const userName = naming.userName;

  const include = {
    description: true,
    personality: true,
    scenario: true,
    mes_example: true,
    first_mes: false,
    post_history_instructions: true,
    depth_prompt: true,
    ...opts.include,
  };
  const useCardSystemPrompt = opts.useCardSystemPrompt ?? true;
  const alternateGreetingIndex = opts.alternateGreetingIndex ?? 0;

  const macroCtx = {
    characterName,
    userName,
    personaDescription: naming.personaDescription || '',
    original: FALLBACK_ORIGINAL,
  };

  const cardSystemPrompt = str(/** @type {any} */ (data).system_prompt);
  let systemPrompt;
  if (cardSystemPrompt.trim() && useCardSystemPrompt) {
    systemPrompt = resolveMacros(cardSystemPrompt, macroCtx);
  } else {
    const parts = [];
    if (include.description) {
      parts.push(section('Description', str(data.description)));
    }
    if (include.personality) {
      parts.push(section('Personality', str(data.personality)));
    }
    if (include.scenario) {
      parts.push(section('Scenario', str(data.scenario)));
    }
    if (include.mes_example) {
      parts.push(section('Example dialogue', str(data.mes_example)));
    }
    if (include.first_mes) {
      const greetings = Array.isArray(data.alternate_greetings)
        ? data.alternate_greetings
        : [];
      const greeting =
        alternateGreetingIndex > 0
          ? str(greetings[alternateGreetingIndex - 1])
          : str(data.first_mes);
      parts.push(section('Greeting', resolveMacros(greeting, macroCtx)));
    }
    const assembled = parts
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    systemPrompt =
      assembled.length > 0
        ? assembled
        : resolveMacros(FALLBACK_ORIGINAL, macroCtx);
  }

  let postHistoryInstructions = '';
  if (include.post_history_instructions) {
    const phi = str(/** @type {any} */ (data).post_history_instructions);
    if (phi.trim()) {
      postHistoryInstructions = resolveMacros(phi, macroCtx);
    }
  }

  let depthPrompt = null;
  if (include.depth_prompt) {
    const ext = data.extensions || {};
    const dp = /* @type {any} */ ext.depth_prompt;
    if (dp && (str(dp.prompt).trim() || dp.depth != null)) {
      depthPrompt = {
        depth: typeof dp.depth === 'number' ? dp.depth : 4,
        role:
          dp.role === 'user' || dp.role === 'assistant'
            ? dp.role
            : 'system',
        prompt: resolveMacros(str(dp.prompt), macroCtx),
      };
    }
  }

  return { systemPrompt, postHistoryInstructions, depthPrompt };
};
harden(resolvePrompt);