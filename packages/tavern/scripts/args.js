// @ts-check

/**
 * Minimal argv parser for the importer CLI scripts. Handles:
 *   --flag value
 *   --flag (boolean → true)
 *   --flag=value
 *   positional args (returned in `_`)
 *
 * @param {string[]} argv
 * @returns {{ flags: Record<string,string|boolean>, _: string[] }}
 */
export const parseArgs = argv => {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    /** @type {string | undefined} */
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const name = arg.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
          flags[name] = true;
        } else {
          flags[name] = next;
          i += 1;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, _: positional };
};
harden(parseArgs);