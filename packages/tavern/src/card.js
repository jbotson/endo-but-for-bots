// @ts-check

import fs from 'node:fs/promises';
import path from 'node:path';

import harden from '@endo/harden';

import { readPngCharaText } from './png-text.js';

/**
 * @typedef {object} NormalizedCard
 * @property {object} raw - the verbatim parsed card (V1-as-given or V2-as-given)
 * @property {object} data - V2-shape `data` object (promoted if V1)
 * @property {'v1' | 'v2'} specVersion
 * @property {string} [name]
 * @property {string} format - 'png' | 'json'
 * @property {string} [cardPath] - resolved path the card was loaded from
 */

/**
 * Detect whether a parsed card is the V1 flat shape (top-level
 * `name`/`description`/...) or the V2 shape (everything under `data`).
 *
 * @param {object} card
 * @returns {'v1' | 'v2'}
 */
const detectSpecVersion = card => {
  if (card && typeof card === 'object' && 'data' in card) return 'v2';
  return 'v1';
};

/**
 * Promote a V1 (flat) card into the V2 shape by nesting the known fields
 * under `data`. Unknown V1 fields are preserved verbatim per the ST spec
 * ("never destroy unknown extensions").
 *
 * @param {object} v1
 * @returns {object} V2-shaped card ({ spec: '2.0'?, data: {...} })
 */
const promoteV1 = v1 => {
  const known = [
    'name',
    'description',
    'personality',
    'scenario',
    'first_mes',
    'mes_example',
    'alternate_greetings',
    'avatar',
    'chat',
    'create_date',
    'description',
    'system_prompt',
    'post_history_instructions',
    'tags',
    'creator',
    'character_version',
  ];
  /** @type {Record<string, unknown>} */
  const data = {};
  /** @type {Record<string, unknown>} */
  const rest = { ...v1 };
  for (const key of known) {
    if (key in rest) {
      data[key] = rest[key];
      delete rest[key];
    }
  }
  // alternate_greetings is an array on V1; keep as-is (V2 stores it the same way).
  return { spec: '2.0', data, extensions: {}, ...rest };
};

/**
 * Parse a SillyTavern character card from a file on disk. PNG cards carry
 * the V2 data as base64 JSON in a `tEXt` "chara" chunk; `.json` files may
 * be V1 (flat) or V2 (under `data`).
 *
 * Never throws away unknown fields — `raw` is the verbatim parsed object
 * so `card.json` can be written byte-faithfully downstream.
 *
 * @param {string} cardPath
 * @returns {Promise<NormalizedCard>}
 */
export const parseCardFile = async cardPath => {
  const ext = path.extname(cardPath).toLowerCase();
  if (ext === '.png') {
    const json = await readPngCharaText(cardPath);
    const parsed = JSON.parse(json);
    return normalizeCard(parsed, 'png', cardPath);
  }
  if (ext === '.json') {
    const text = await fs.readFile(cardPath, 'utf8');
    const parsed = JSON.parse(text);
    return normalizeCard(parsed, 'json', cardPath);
  }
  throw new Error(
    `Unsupported card extension "${ext}" — expected .png or .json`,
  );
};
harden(parseCardFile);

/**
 * @param {object} parsed
 * @param {'png' | 'json'} format
 * @param {string} [cardPath]
 * @returns {NormalizedCard}
 */
const normalizeCard = (parsed, format, cardPath) => {
  const specVersion = detectSpecVersion(parsed);
  if (specVersion === 'v1') {
    /** @type {object} */
    const promoted = promoteV1(parsed);
    return {
      raw: parsed,
      data: /** @type {object} */ (promoted.data),
      specVersion,
      name: /** @type {any} */ (parsed).name || /** @type {any} */ (promoted.data).name,
      format,
      cardPath,
    };
  }
  return {
    raw: parsed,
    data: /** @type {any} */ (parsed).data || {},
    specVersion,
    name: /** @type {any} */ (parsed).data?.name,
    format,
    cardPath,
  };
};
harden(normalizeCard);