// @ts-check

import harden from '@endo/harden';

/**
 * SillyTavern macro substitution — a deliberately small subset of ST's
 * `{{macro}}` system. We expand the macros that affect prompt assembly and
 * collapse runs of whitespace (ST does this for prompt-pre formatting).
 *
 * Unsupported by design (documented limitations): STscript, regex scripts,
 * `{{random:a,b}}`, `{{roll:dN}}`, time/date macros, and the full gamut of
 * conditional/incremental macros. Cards that use them will see the macro
 * text pass through verbatim rather than crash.
 *
 * @param {string} text
 * @param {{ characterName: string, userName: string, personaDescription?: string, original?: string }} ctx
 * @returns {string}
 */
export const resolveMacros = (text, ctx) => {
  const { characterName, userName, personaDescription = '', original = '' } = ctx;
  let out = text;
  out = out.split('{{char}}').join(String(characterName));
  out = out.split('{{Char}}').join(capitalize(String(characterName)));
  out = out.split('{{user}}').join(String(userName));
  out = out.split('{{User}}').join(capitalize(String(userName)));
  out = out.split('{{persona}}').join(personaDescription);
  out = out.split('{{original}}').join(original);
  // Collapse 3+ newlines to at most two, and trim trailing whitespace per ST.
  out = out.replace(/\n{3,}/g, '\n\n');
  return out;
};

/**
 * @param {string} s
 * @returns {string}
 */
const capitalize = s =>
  s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);

harden(resolveMacros);