// @ts-check
/* global process */

import path from 'node:path';
import os from 'node:os';

import harden from '@endo/harden';
import { whereEndoState } from '@endo/where';

/**
 * Validate that `name` is a usable Endo pet name for an agent:
 * lowercase, alnum-and-hyphen, 1-128 chars. Mirrors the daemon's pet-name
 * rule (the `@`-prefixed special names are reserved).
 *
 * @param {string} name
 * @returns {string} the validated name
 */
export const validateAgentName = name => {
  const valid = /^[a-z0-9][a-z0-9-]{0,127}$/.test(name);
  if (!valid) {
    throw new Error(
      `Invalid agent name "${name}": must match /^[a-z0-9][a-z0-9-]{0,127}$/`,
    );
  }
  return name;
};
harden(validateAgentName);

/**
 * Slugify an arbitrary character name into a safe agent-name component
 * (lowercase, non-alnum → `-`, trimmed, deduped hyphens).
 *
 * @param {string} raw
 * @returns {string}
 */
export const slugify = raw => {
  const s = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.length === 0 ? 'agent' : s.slice(0, 128);
};
harden(slugify);

/**
 * Resolve the default Endo state directory for this host, mirroring the
 * daemon's own `whereEndoState(process.platform, process.env, info)`.
 * The info object supplies fallback `home`/`user`/`temp` used on some
 * platforms.
 *
 * @param {{ platform?: string, env?: Record<string,string|undefined>, info?: object }} [ctx]
 * @returns {string}
 */
export const resolveEndoStateDir = (ctx = {}) => {
  const platform = ctx.platform ?? process.platform;
  const env = ctx.env ?? process.env;
  const info = ctx.info ?? {
    home: os.homedir(),
    user: os.userInfo().username,
    temp: os.tmpdir(),
  };
  return whereEndoState(platform, env, info);
};
harden(resolveEndoStateDir);

/**
 * Default per-agent state directory: `<endo-state>/tavern/<agent-name>/`.
 *
 * @param {string} agentName
 * @param {{ endoStateDir?: string }} [ctx]
 * @returns {string}
 */
export const defaultStateDir = (agentName, ctx = {}) => {
  const root = ctx.endoStateDir ?? resolveEndoStateDir();
  return path.join(root, 'tavern', agentName);
};
harden(defaultStateDir);

/**
 * Resolve a file path under `stateDir`, rejecting traversal escapes. The
 * agent's own state dir is the only place the driver is allowed to read or
 * write (same `resolveSafe` invariant fae enforces for FS tools).
 *
 * @param {string} stateDir
 * @param {string} name
 * @returns {string}
 */
export const resolveSafe = (stateDir, name) => {
  // Normalize then verify the result is still inside stateDir.
  const joined = path.resolve(stateDir, name);
  const base = path.resolve(stateDir);
  if (joined !== base && !joined.startsWith(`${base}${path.sep}`)) {
    throw new Error(`Path "${name}" escapes state dir "${stateDir}"`);
  }
  return joined;
};
harden(resolveSafe);