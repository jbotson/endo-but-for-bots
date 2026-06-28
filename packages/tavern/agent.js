// @ts-nocheck - E() generics don't work well with JSDoc types for remote objects
/* eslint-disable no-await-in-loop, @endo/restrict-comparison-operands */

import path from 'node:path';
import fsp from 'node:fs/promises';

import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { makePromiseKit } from '@endo/promise-kit';
import { passableAsJustin, makeMarshal } from '@endo/marshal';
import { makeRefIterator } from '@endo/daemon/ref-reader.js';
import { createProvider } from '@endo/lal/providers/index.js';
import { makeConversationTree } from '@endo/conversation-tree';

import {
  discoverTools,
  executeTool,
} from '@endo/fae/src/tools.js';
import { extractToolCallsFromContent } from '@endo/fae/src/extract-tool-calls.js';
import {
  makeListPetnamesTool,
  makeLookupTool,
  makeStoreTool,
  makeRemoveTool,
  makeAdoptTool,
  makeAdoptToolTool,
  makeSendTool,
  makeReplyTool,
  makeListMessagesTool,
  makeDismissTool,
  makeReadChannelTool,
} from './src/tool-makers.js';
import { makeDiskBackend } from './src/disk-backend.js';
import {
  loadAgent,
  loadState,
  saveState,
  saveJson,
  loadJson,
  CONTEXT_DEFAULTS,
} from './src/agent-state.js';

/** Same pattern as isSpecialName in packages/daemon/src/pet-name.js */
const specialNamePattern = /^[A-Z][A-Z0-9-]{0,127}$/;

const m = makeMarshal(undefined, undefined, {
  errorTagging: 'off',
  serializeBodyFormat: 'smallcaps',
});
const decodeSmallcaps = jsonString =>
  m.unserialize({ body: jsonString, slots: [] });

const TavernFactoryInterface = M.interface('TavernFactory', {
  createAgent: M.callWhen(M.string())
    .optional(M.record())
    .returns(M.string()),
  destroyAgent: M.callWhen(M.string()).returns(M.string()),
  locateAgent: M.call(M.string()).returns(M.promise()),
  help: M.call().optional(M.string()).returns(M.string()),
});

/**
 * @typedef {object} AgentConfig
 * @property {string} systemPrompt
 * @property {string} postHistoryInstructions
 * @property {{ depth: number, role: 'system' | 'user' | 'assistant', prompt: string } | null} [depthPrompt]
 * @property {boolean} [fsync]
 * @property {{ name: string }} [provider]
 * @property {string | null} [model]
 * @property {number} [contextBudgetTokens]
 * @property {number} [summarizeAtRatio]
 * @property {string} [summarizeDirective]
 * @property {boolean} [enableSummarization]
 */

/**
 * Assemble the per-turn LLM input from `agent.json`'s authoritative system
 * prompt and the conversation path recorded on disk, injecting the card's
 * `depth_prompt` and ephemeral `post_history_instructions` tail.
 *
 * A leading `system` message from a stored portability root (§4.1) is
 * stripped — the live prompt is `agent.json`, never the tree.
 *
 * @param {AgentConfig} cfg
 * @param {object[]} pathMessages
 * @returns {object[]}
 */
const assembleContext = (cfg, pathMessages) => {
  const msgs = pathMessages.slice();
  // No stripping here — getEffectivePath already handles portability-root
  // vs. summary boundaries. The agent.json system prompt is authoritative.
  const out = [{ role: 'system', content: cfg.systemPrompt }, ...msgs];

  const dp = cfg.depthPrompt;
  if (dp && typeof dp.prompt === 'string' && dp.prompt.trim()) {
    const d = typeof dp.depth === 'number' ? dp.depth : 4;
    const role = dp.role === 'user' || dp.role === 'assistant' ? dp.role : 'system';
    const at = Math.max(1, out.length - d);
    out.splice(at, 0, { role, content: dp.prompt });
  }

  if (cfg.postHistoryInstructions && cfg.postHistoryInstructions.trim()) {
    out.push({ role: 'system', content: cfg.postHistoryInstructions });
  }

  return out;
};

/**
 * Resolve the current leaf of a (v1-linear) disk tree by walking children of
 * the first root until none has a child. Returns `null` for an empty tree.
 *
 * @param {import('./src/types.js').ConversationTree} tree
 * @returns {Promise<string | null>}
 */
const resolveCurrentLeaf = async tree => {
  const roots = await tree.getRoots();
  if (roots.length === 0) return null;
  let cursor = roots[0].id;
  for (;;) {
    const children = await tree.getChildren(cursor);
    if (children.length === 0) return cursor;
    cursor = children[0].id;
  }
};

/**
 * Walk the node chain from leaf → root and collect messages, but stop when
 * a summary node is reached — the summary *becomes* the effective root.
 * This is what `assembleContext` consumes instead of the raw `tree.getPath`,
 * so that committed summaries prevent the context window from growing
 * unbounded without destroying history on disk.
 *
 * @param {import('./src/types.js').ConversationTree} tree
 * @param {string} leafId
 * @returns {Promise<object[]>}
 */
const getEffectivePath = async (tree, leafId) => {
  const chain = [];
  let cursor = leafId;
  while (cursor !== null && cursor !== undefined) {
    const node = await tree.getNode(cursor);
    if (node === null) break;
    chain.push(node);
    if (node.metadata && node.metadata.summary) {
      break; // summary node becomes the effective root
    }
    cursor = node.parentId;
  }
  chain.reverse();
  const messages = [];
  for (let i = 0; i < chain.length; i += 1) {
    const node = chain[i];
    // Skip the import-time portability root's system message: it's the root
    // (parentId === null), not a summary, and its messages are all system.
    // The live system prompt comes from agent.json (assembled by
    // assembleContext), never from this stored root (§4.1).
    if (
      node.parentId === null &&
      !(node.metadata && node.metadata.summary) &&
      node.messages.every(msg => msg.role === 'system')
    ) {
      /* skip portability root — agent.json system prompt is authoritative */
    } else {
      messages.push(...node.messages);
    }
  }
  return messages;
};

/**
 * Rough token estimate: ~4 chars per token. Not tokenizer-accurate, but
 * sufficient for triggering the 'consider summarizing' directive. The LLM
 * self-verifies the summary via probe before committing.
 *
 * @param {object[]} messages
 * @returns {number}
 */
const estimateTokens = messages => {
  return Math.ceil(JSON.stringify(messages).length / 4);
};

/**
 * Substitute placeholders in the configurable directive template.
 *
 * @param {string} template
 * @param {number} estTokens
 * @param {number} budgetTokens
 * @returns {string}
 */
const buildDirective = (template, estTokens, budgetTokens) => {
  return template
    .replace(/\{\{estTokens\}\}/g, String(estTokens))
    .replace(/\{\{budgetTokens\}\}/g, String(budgetTokens));
};
harden(buildDirective);

/**
 * Truncate any message whose `content` string exceeds `maxChars`. The
 * truncated content is replaced with the first `maxChars` bytes plus a
 * visible notice so the LLM knows the output was too large. This prevents
 * runaway outputs (e.g. infinite loops) from blowing up the context window
 * and tree.jsonl.
 *
 * Operates on a shallow copy of each message; the originals are not mutated.
 *
 * @param {object[]} messages
 * @param {number} maxChars
 * @returns {object[]}
 */
const truncateMessages = (messages, maxChars) => {
  if (!maxChars || maxChars <= 0) return messages;
  let truncated = false;
  const result = messages.map(msg => {
    const content = /** @type {any} */ (msg).content;
    if (typeof content === 'string' && content.length > maxChars) {
      truncated = true;
      const originalLen = content.length;
      return {
        ...msg,
        content:
          `${content.slice(0, maxChars)}\n\n[... output truncated: was ${originalLen} chars, limit is ${maxChars} ...]`,
      };
    }
    return msg;
  });
  if (truncated) {
    console.warn(
      `[tavern] one or more messages truncated to ${maxChars} chars`,
    );
  }
  return result;
};
harden(truncateMessages);

/**
 * @typedef {object} ProviderConstructorConfig
 * @property {string} host
 * @property {string} model
 * @property {string} authToken
 */

/**
 * @typedef {object} InjectedProviderConfig
 * @property {{ chat: (messages: object[], tools: object[]) => Promise<{ message: object }> }} provider
 */

/**
 * Spawn the tavern inbox/LLM loop for a single agent, backed by a disk
 * conversation tree.
 *
 * The only structural differences from fae's `spawnWorkerLoop` are:
 *   - backend = disk (`makeDiskBackend`), not the daemon petstore;
 *   - the system prompt is pulled from `agent.json` each turn (never a
 *     stored root) so prompt edits take effect without recreating the agent;
 *   - history persists to `tree.jsonl`.
 *
 * @param {any} powers - the agent's guest powers (inbox, petstore, tools)
 * @param {Promise<object> | object | undefined} context - cancellation context
 * @param {ProviderConstructorConfig | InjectedProviderConfig} providerConfig
 * @param {string} stateDir - per-agent state directory on disk
 * @param {string} agentName - agent name (used only for logging/`@host` ready)
 * @param {object} [factoryRef] - the TavernFactory ref, for spawning/tearing
 *   down probe sub-agents during summary verification (may be `undefined` in
 *   tests where probes are mocked).
 * @param {object} [hostRef] - the EndoHost ref, for `makeTimer`/`cancel`
 *   (the agent's EndoGuest doesn't expose these). May be `undefined` in tests.
 * @returns {Promise<void>}
 */
export const spawnTavernLoop = async (
  powers,
  context,
  providerConfig,
  stateDir,
  agentName,
  factoryRef,
  hostRef,
) => {
  const treePath = path.join(stateDir, 'tree.jsonl');
  const agentPath = path.join(stateDir, 'agent.json');
  const statePath = path.join(stateDir, 'state.json');

  const getCancelled = async () => {
    if (!context) return null;
    const resolvedContext = await context;
    if (!resolvedContext) return null;
    if (typeof resolvedContext.whenCancelled === 'function') {
      return E(resolvedContext).whenCancelled();
    }
    if (resolvedContext.cancelled) {
      return resolvedContext.cancelled;
    }
    return null;
  };

  /**
   * Load agent.json once at startup so `model` (an optional override of the
   * provider's model) and `fsync` are available before the LAL provider is
   * constructed. The system prompt / PHI / depth are re-read each turn (§4);
   * `model` and `fsync` are startup-only and take effect on next restart.
   */
  let fsync = false;
  let modelOverride = null;
  let enableSummarization = false;
  try {
    const startup = await loadAgent(agentPath);
    fsync = Boolean(startup.fsync);
    modelOverride = startup.model ?? null;
    enableSummarization = Boolean(startup.enableSummarization);
  } catch (error) {
    console.error(
      `[tavern] agent.json unreadable at startup: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // `agent.json.model` optionally overrides the stored provider's model, so a
  // model-only switch (same host/auth) is just an edit + restart — no
  // provider re-provisioning or driver rebinding required.
  const provider =
    providerConfig.provider ||
    createProvider({
      LAL_HOST: providerConfig.host,
      LAL_MODEL: modelOverride || providerConfig.model,
      LAL_AUTH_TOKEN: providerConfig.authToken,
    });

  const chat = (messages, toolSchemas) => provider.chat(messages, toolSchemas);

  const backend = await makeDiskBackend(treePath, { fsync });
  const tree = makeConversationTree(backend);

  let currentLeafId = await resolveCurrentLeaf(tree);

  // Shared mutable leaf tracker. The agentic loop AND the summary tools
  // (commitSummary) both read/write this — when commitSummary appends a
  // summary node mid-loop, the loop's next step node parents from the
  // summary node, keeping it on the path from leaf → root.
  let sharedLeafId = currentLeafId;

  const state = await loadState(statePath);

  // Built-in tools (petstore + mail + exec + channel), all from fae's makers.
  /** @type {Map<string, object>} */
  const localTools = new Map();
  localTools.set('list', makeListPetnamesTool(powers));
  localTools.set('lookup', makeLookupTool(powers));
  localTools.set('store', makeStoreTool(powers));
  localTools.set('remove', makeRemoveTool(powers));
  localTools.set('adopt', makeAdoptTool(powers));
  localTools.set('adoptTool', makeAdoptToolTool(powers));
  localTools.set('send', makeSendTool(powers));
  const replyTracker = { sent: false };
  const baseReplyTool = makeReplyTool(powers);
  localTools.set(
    'reply',
    harden({
      schema: () => baseReplyTool.schema(),
      async execute(args) {
        replyTracker.sent = true;
        return baseReplyTool.execute(args);
      },
      help: () => baseReplyTool.help(),
    }),
  );
  localTools.set('listMessages', makeListMessagesTool(powers));
  localTools.set('dismiss', makeDismissTool(powers));

  // Tavern's enhanced exec: same as fae's, but with makeExo, M, and readOnly
  // as additional endowments, so the agent can create CapTP-safe remotables,
  // interface guards, and read-only attenuations of existing capabilities.
  // The agent gets makeExo/M (pure minting/validation, no raw capability) and
  // a readOnly helper that creates recursively-attenuated facets over
  // petstore values (directories return read-only views, not raw objects).

  /**
   * Create a read-only exo facet over a petstore value. For directories,
   * exposes only has/list/lookup/help, with lookup recursively wrapping
   * returned values. For files, exposes only text/json/help. For plain
   * pass-by-copy values (JSON), returns as-is (already immutable).
   *
   * @param {object} obj - the raw petstore value (an ERef)
   * @param {{ includeUnknown?: boolean }} [opts] - if true, unknown object types
   *   are passed through as-is (dangerous — may expose write capabilities).
   *   Defaults to false: unknown types throw an error so the agent can
   *   decide whether to override.
   * @returns {Promise<object>} a narrowed, read-only exo facet
   */
  const readOnly = async (obj, opts = {}) => {
    if (obj === null || typeof obj !== 'object') return obj;

    // Probe the object's CapTP method names to detect its type.
    const getMethodNames = '__getMethodNames__'; // eslint-disable-line no-underscore-dangle
    let methodNames;
    try {
      methodNames = await E(obj)[getMethodNames]();
    } catch {
      // Not a Far/exo object — pass-by-copy, already immutable.
      return obj;
    }
    if (!Array.isArray(methodNames)) return obj;

    const isDirectory = methodNames.includes('has') && methodNames.includes('lookup');
    const isFile = methodNames.includes('text') || methodNames.includes('json');

    if (isDirectory) {
      return makeExo('ReadOnlyDirectory', M.interface('ReadOnlyDirectory', {
        has: M.call().rest(M.any()).returns(M.promise()),
        list: M.call().rest(M.any()).returns(M.promise()),
        lookup: M.call(M.any()).returns(M.promise()),
        help: M.call().optional(M.string()).returns(M.string()),
      }), {
        has: (...namePath) => E(obj).has(...namePath),
        list: (...namePath) => E(obj).list(...namePath),
        lookup: async name => {
          const inner = await E(obj).lookup(name);
          // Recursively attenuate: nested directories, files, and plain
          // values all go through readOnly, so the probe never gets a raw
          // modifiable object through traversal.
          return readOnly(inner, opts);
        },
        help: methodName =>
          methodName === undefined
            ? 'Read-only directory view (has, list, lookup). Modifications are not available.'
            : `Read-only: ${methodName}`,
      });
    }

    if (isFile) {
      const fileMethods = {};
      if (methodNames.includes('text')) {
        fileMethods.text = () => E(obj).text();
      }
      if (methodNames.includes('json')) {
        fileMethods.json = () => E(obj).json();
      }
      fileMethods.help = methodName =>
        methodName === undefined
          ? 'Read-only file view (text, json). Modifications are not available.'
          : `Read-only: ${methodName}`;
      return makeExo('ReadOnlyFile', M.interface('ReadOnlyFile', M.call().rest(M.any()).returns(M.any())), fileMethods);
    }

    // Unknown object type — this could be anything, including objects with
    // write capabilities (storeIdentifier, remove, send, etc.). Default to
    // throwing so the agent consciously decides to override via
    // { includeUnknown: true }.
    if (opts.includeUnknown) {
      console.warn('[tavern] readOnly: passing through unknown object type — may expose write capabilities');
      return obj;
    }
    throw new Error(
      `readOnly: unknown object type with methods [${methodNames.join(', ')}]. ` +
      'This object may have write capabilities. ' +
      'Pass { includeUnknown: true } to readOnly() if you intentionally want to share it unattenuated.',
    );
  };

  localTools.set(
    'exec',
    harden({
      schema() {
        return harden({
          type: 'function',
          function: {
            name: 'exec',
            description:
              'Execute JavaScript code with access to your guest powers. ' +
              'The code runs as an async function body (top-level await works). ' +
              'Return a value to get it as the tool result.\n\n' +
              'Available parameters:\n' +
              '- powers: your guest interface (adopt, reply, send, lookup, list, etc.)\n' +
              '- E: eventual send — use E(ref).method() for all remote calls\n' +
              '- harden: freeze objects for safe passing\n' +
              '- console: for logging\n' +
              '- makeExo: create a CapTP-safe remotable with an interface guard\n' +
              '- M: pattern library for interface guards\n' +
              '- readOnly: create a read-only, recursively-attenuated facet over a ' +
              'petstore value (directories return read-only views on lookup, not raw objects). ' +
              'Throws if the object type is unknown (not a directory or file) — pass ' +
              '{ includeUnknown: true } as the second argument to override, but be aware ' +
              'this may pass through an object with write capabilities.\n\n' +
              'Example — create a read-only view of a directory and send it to a probe:\n' +
              '```\n' +
              'const dir = await E(powers).lookup("my-directory");\n' +
              'const roDir = await readOnly(dir);\n' +
              'await E(powers).storeValue(roDir, "temp-shared");\n' +
              'await E(powers).send("probe-name", ["Here is @readonly-dir"], ["readonly-dir"], ["temp-shared"]);\n' +
              'return "Shared read-only directory with probe";\n' +
              '```',
            parameters: {
              type: 'object',
              properties: {
                code: {
                  type: 'string',
                  description:
                    'JavaScript code to execute. Runs as an async function body. ' +
                    'Use E(powers).method() for guest operations. Return a result.',
                },
              },
              required: ['code'],
            },
          },
        });
      },
      async execute(args) {
        const { code } = /** @type {{ code: string }} */ (args);
        if (!code) {
          throw new Error('code is required');
        }
        const wrappedSource = `(async (powers, E, harden, console, makeExo, M, readOnly) => {\n${code}\n})`;
        const c = new Compartment({
          __options__: true,
          globals: { BigInt },
        });
        const fn = c.evaluate(wrappedSource);
        const result = await fn(powers, E, harden, console, makeExo, M, readOnly);
        if (result === undefined) {
          return 'done (no return value)';
        }
        try {
          return JSON.stringify(result, null, 2);
        } catch {
          return String(result);
        }
      },
      help() {
        return (
          'Execute JavaScript code with powers, E, harden, console, makeExo, M, ' +
          'and readOnly (read-only facet creation). Use for multi-step operations ' +
          'and creating CapTP-safe attenuated capabilities.'
        );
      },
    }),
  );

  localTools.set('readChannel', makeReadChannelTool(powers));

  // --- Self-defined tools (defineTool / removeTool) ---
  //
  // Lets the agent create persistent, reusable tools from JavaScript code.
  // Definitions are stored as JSON in the `tool-defs/` petstore directory
  // and hydrated into FaeTool objects at startup + immediately when defined.
  //
  // **Confinement**: each defined tool's `execute` runs in a locked-down
  // `Compartment` with the same endowments as `exec` — `{ BigInt }` only,
  // with `args`, `powers`, `E`, `harden`, `console` passed as function
  // parameters. No access to the driver's scope, no file system, no process.

  /**
   * Create a FaeTool from a stored definition. The execute body runs in a
   * Compartment identical to exec's confinement.
   *
   * @param {{ name: string, description: string, parameters: object, code: string, help?: string }} def
   * @returns {object}
   */
  const makeDefinedTool = (def, powersArg) => {
    const toolSchema = harden({
      type: 'function',
      function: {
        name: def.name,
        description: def.description,
        parameters: def.parameters,
      },
    });
    return harden({
      schema() {
        return toolSchema;
      },
      async execute(args) {
        const wrappedSource = `(async (args, powers, E, harden, console) => {\n${def.code}\n})`;
        const c = new Compartment({
          __options__: true,
          globals: { BigInt },
        });
        const fn = c.evaluate(wrappedSource);
        const result = await fn(args, powersArg, E, harden, console);
        if (result === undefined) {
          return 'done (no return value)';
        }
        try {
          return JSON.stringify(result, null, 2);
        } catch {
          return String(result);
        }
      },
      help() {
        return def.help || def.description;
      },
    });
  };

  /**
   * Load all tool definitions from `tool-defs/` into localTools at startup.
   */
  /**
   * Load all tool definitions from `<stateDir>/tool-defs/<name>.json` into
   * localTools at startup. Stored on the host filesystem (not the petstore)
   * because the driver is --UNCONFINED and this is more robust: survives GC,
   * petstore issues, and is inspectable by the user.
   */
  const toolDefsDir = path.join(stateDir, 'tool-defs');

  const loadDefinedTools = async () => {
    try {
      await fsp.mkdir(toolDefsDir, { recursive: true });
    } catch {
      // already exists
    }
    let files;
    try {
      files = await fsp.readdir(toolDefsDir);
    } catch {
      // dir doesn't exist or unreadable — no defined tools to load
      return;
    }
    for (const file of files) {
      if (file.endsWith('.json')) {
        try {
          const text = await fsp.readFile(path.join(toolDefsDir, file), 'utf8');
          const def = JSON.parse(text);
          if (def && def.name && def.code) {
            localTools.set(def.name, makeDefinedTool(def, powers));
            console.log(`[tavern] Loaded defined tool "${def.name}"`);
          }
        } catch (err) {
          console.error(
            `[tavern] Error loading tool def "${file}":`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }
  };

  localTools.set(
    'defineTool',
    harden({
      schema() {
        return harden({
          type: 'function',
          function: {
            name: 'defineTool',
            description:
              'Define a reusable tool from JavaScript code. The code runs in ' +
              'a sandboxed Compartment with the same confinement as exec ' +
              '(globals: args, powers, E, harden, console, BigInt — nothing else). ' +
              'The tool is available immediately and persists across daemon restarts.',
            parameters: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description:
                    'Tool name (lowercase, alnum + hyphen, 1-128 chars). Must not collide with existing tools.',
                },
                description: {
                  type: 'string',
                  description: 'Short description of what the tool does (shown to the LLM).',
                },
                parameters: {
                  description:
                    'JSON Schema for the tool\'s parameters (same shape as OpenAI function parameters).',
                },
                code: {
                  type: 'string',
                  description:
                    'JavaScript code to run when the tool is called. Runs as an async function body. ' +
                    'Receives `args` (the tool call arguments), `powers`, `E`, `harden`, `console`. ' +
                    'Return a value to send back to the LLM.',
                },
                help: {
                  type: 'string',
                  description: 'Optional help text (defaults to description).',
                },
              },
              required: ['name', 'description', 'parameters', 'code'],
            },
          },
        });
      },
      async execute(args) {
        const {
          name,
          description,
          parameters,
          code,
          help,
        } = /** @type {{ name: string, description: string, parameters: object, code: string, help?: string }} */ (
          args
        );
        if (!name || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(name)) {
          return 'Error: name must match /^[a-z0-9][a-z0-9-]{0,127}$/';
        }
        if (!code) {
          return 'Error: code is required';
        }
        const def = { name, description: description || '', parameters: parameters || { type: 'object', properties: {} }, code, help: help || description || '' };
        // Persist as JSON on the host filesystem (not the petstore) — more
        // robust: survives GC, petstore issues, and is inspectable.
        await fsp.mkdir(toolDefsDir, { recursive: true });
        await fsp.writeFile(
          path.join(toolDefsDir, `${name}.json`),
          JSON.stringify(def, null, 2),
          'utf8',
        );
        // Add to localTools immediately (available on the next LLM call
        // in this agentic loop after re-discovery)
        localTools.set(name, makeDefinedTool(def, powers));
        console.log(`[tavern] Defined tool "${name}"`);
        return `Tool "${name}" defined and available immediately. It will persist across daemon restarts.`;
      },
      help() {
        return 'Define a reusable tool from JavaScript code. The tool runs in a sandboxed Compartment with the same confinement as exec.';
      },
    }),
  );

  localTools.set(
    'removeTool',
    harden({
      schema() {
        return harden({
          type: 'function',
          function: {
            name: 'removeTool',
            description:
              'Remove a tool previously defined with defineTool. Deletes it from memory and from disk.',
            parameters: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description: 'The name of the tool to remove.',
                },
              },
              required: ['name'],
            },
          },
        });
      },
      async execute(args) {
        const { name } = /** @type {{ name: string }} */ (args);
        if (!name) {
          return 'Error: name is required';
        }
        localTools.delete(name);
        try {
          await fsp.rm(path.join(toolDefsDir, `${name}.json`), { force: true });
        } catch {
          // best-effort
        }
        console.log(`[tavern] Removed tool "${name}"`);
        return `Tool "${name}" removed.`;
      },
      help() {
        return 'Remove a self-defined tool. Deletes it from memory and persistent storage.';
      },
    }),
  );
  // --- end self-defined tools ---

  // --- Scheduled jobs (createSchedule / removeSchedule) ---
  //
  // Lets the agent schedule periodic "cron-style" jobs that wake it up with
  // a new turn at a configured interval (minimum 60s — this is for
  // a few-times-a-day scheduling, not sub-second timers).
  //
  // Built on the daemon's makeTimer, but bridges the timer's callback-based
  // onTick into a local queue that the main loop races on — so the agent
  // wakes up as a new turn without an inbox message (self-sends would be
  // filtered by the fromId === selfLocator check in the message loop).

  /**
   * Local queue for scheduled ticks. When a timer fires, onTick enqueues here
   * and resolves tickSignal — the main loop races on this so it wakes without
   * an inbox message. This avoids the self-send filter (fromId === selfLocator)
   * that would silently drop schedule messages routed through the inbox.
   */
  const pendingTicks = [];
  let tickSignal = makePromiseKit();

  const enqueueTick = (jobName, tickMessage, isCatchup = false) => {
    const timestamp = new Date().toISOString();
    pendingTicks.push({ jobName, message: tickMessage, isCatchup, timestamp });
    tickSignal.resolve();
  };

  /**
   * In-memory map of jobName → schedule info (timerPetName, message, interval,
   * label). Persisted to schedules.json so schedules survive driver restarts;
   * on restart, loadSchedules re-subscribes to the timers and fires one
   * catch-up tick if a scheduled tick was missed during downtime.
   *
   * @type {Map<string, { timerPetName: string, message: string, intervalMs: number, label: string, lastRun: string | null }>}
   */
  const scheduledJobs = new Map();

  const schedulesPath = path.join(stateDir, 'schedules.json');

  /**
   * Persist the current set of scheduled jobs to `schedules.json`.
   * This file is read at startup to re-subscribe to timers after restart.
   *
   * @param {Map<string, { timerPetName: string, message: string, intervalMs: number, label: string }>} jobs
   */
  const saveSchedules = async jobs => {
    const entries = [];
    for (const [jobName, info] of jobs) {
      entries.push({ jobName, ...info });
    }
    await saveJson(schedulesPath, entries);
  };

  /**
   * Update lastRun for a job and persist.
   *
   * @param {string} jobName
   */
  const touchSchedule = async jobName => {
    const info = scheduledJobs.get(jobName);
    if (info) {
      info.lastRun = new Date().toISOString();
      await saveSchedules(scheduledJobs);
    }
  };

  /**
   * Load schedules.json and re-subscribe to existing timers. For each schedule,
   * fire one catch-up tick if the timer already exists (meaning the daemon was
   * running and the schedule was missed since the driver last restarted).
   * If the timer no longer exists (e.g. cancelled while driver was down), the
   * schedule is dropped silently.
   *
   * @param {object} hostRefArg - the narrowed TimerHost exo (from driver)
   */
  const loadSchedules = async hostRefArg => {
    if (!hostRefArg) return;
    const data = await loadJson(schedulesPath);
    if (!data || !Array.isArray(data) || data.length === 0) return;

    const now = Date.now();
    const loaded = new Map();
    for (const entry of data) {
      const { jobName, timerPetName, message, intervalMs, label } = entry;

      try {
        // Check if the timer still exists. If it was cancelled while the
        // driver was down, this throws and we drop the schedule.
        const timer = await E(hostRefArg).lookup([timerPetName]);

        // Re-subscribe with the same Far callback pattern as createSchedule.
        const subscriber = Far('ScheduleSubscriber', {
          async onTick(tick) {
            const tickMessage = `[Scheduled job "${jobName}" tick #${tick.tick} at ${tick.timestamp}]\n${message}`;
            try {
              enqueueTick(jobName, tickMessage);
            } catch (err) {
              console.error(
                `[tavern] schedule "${jobName}" tick failed:`,
                err instanceof Error ? err.message : String(err),
              );
            }
            touchSchedule(jobName).catch(() => {});
          },
        });
        await E(timer).subscribe(subscriber);

        const lastRun = entry.lastRun || null;
        loaded.set(jobName, { timerPetName, message, intervalMs, label, lastRun });
        scheduledJobs.set(jobName, { timerPetName, message, intervalMs, label, lastRun });
        console.log(`[tavern] Restored schedule "${jobName}" (every ${intervalMs / 60_000} min)`);

        // Single catch-up: if the schedule was last run before now and the
        // next due time has passed, fire one immediate catch-up tick. We
        // don't fire multiple catch-ups for multiple missed ticks.
        const lastRunMs = lastRun ? new Date(lastRun).getTime() : 0;
        const nextDue = lastRunMs + intervalMs;
        if (nextDue < now && lastRunMs > 0) {
          const catchupTimestamp = new Date(now).toISOString();
          console.log(`[tavern] Firing catch-up tick for schedule "${jobName}"`);
          try {
            enqueueTick(
              jobName,
              `[Scheduled job "${jobName}" catch-up tick at ${catchupTimestamp}]\n${message}`,
              true,
            );
          } catch {
            // best-effort
          }
        }
      } catch {
        // Timer no longer exists — drop the schedule silently.
        console.log(`[tavern] Schedule "${jobName}" timer no longer exists; dropping`);
      }
    }
    // Save the restored set (without lastRun — it'll be updated on next tick)
    await saveSchedules(loaded);
  };

  localTools.set(
    'createSchedule',
    harden({
      schema() {
        return harden({
          type: 'function',
          function: {
            name: 'createSchedule',
            description:
              'Schedule a recurring job that wakes you with a new turn at a ' +
              'specified interval. Use this for periodic tasks (e.g. checking ' +
              'on something a few times a day), not sub-second timers. The ' +
              'minimum interval is 60 seconds. The job persists across daemon ' +
              'restarts. Use removeSchedule to cancel.',
            parameters: {
              type: 'object',
              properties: {
                jobName: {
                  type: 'string',
                  description:
                    'A short name for the job (lowercase, alnum + hyphen). Used to identify the job later.',
                },
                intervalMinutes: {
                  type: 'number',
                  description:
                    'Interval between messages in minutes. Minimum 1 (60 seconds).',
                },
                message: {
                  type: 'string',
                  description:
                    'The message text to send to you on each tick. ' +
                    'This is what you (the agent) will receive as a new conversation turn.',
                },
                label: {
                  type: 'string',
                  description: 'Optional human-readable label for the timer (defaults to jobName).',
                },
              },
              required: ['jobName', 'intervalMinutes', 'message'],
            },
          },
        });
      },
      async execute(args) {
        const {
          jobName,
          intervalMinutes,
          message,
          label,
        } = /** @type {{ jobName: string, intervalMinutes: number, message: string, label?: string }} */ (
          args
        );
        if (!jobName || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(jobName)) {
          return 'Error: jobName must match /^[a-z0-9][a-z0-9-]{0,127}$/';
        }
        if (!message) {
          return 'Error: message is required';
        }
        const minutes = Number(intervalMinutes);
        if (!Number.isFinite(minutes) || minutes < 1) {
          return 'Error: intervalMinutes must be a number >= 1 (60 second minimum)';
        }
        if (!hostRef) {
          return 'Error: host ref not available — cannot create timers in this mode.';
        }
        const intervalMs = Math.round(minutes * 60 * 1000);
        const timerLabel = label || jobName;
        const timerPetName = `schedule-${jobName}`;

        try {
          // makeTimer/cancel are on EndoHost, not EndoGuest — use the host ref.
          await E(hostRef).makeTimer(timerPetName, intervalMs, timerLabel);
          const timer = await E(hostRef).lookup([timerPetName]);

          // Subscribe a callback that enqueues a tick to the local queue
          // on each tick. The main loop races on the tick signal so it
          // wakes up without an inbox message. The GC keeps this alive
          // while the timer formula holds the reference (persistent formula).
          const subscriber = Far('ScheduleSubscriber', {
            async onTick(tick) {
              const tickMessage = `[Scheduled job "${jobName}" tick #${tick.tick} at ${tick.timestamp}]\n${message}`;
              try {
                enqueueTick(jobName, tickMessage);
              } catch (err) {
                console.error(
                  `[tavern] schedule "${jobName}" tick failed:`,
                  err instanceof Error ? err.message : String(err),
                );
              }
              touchSchedule(jobName).catch(() => {});
            },
          });
          await E(timer).subscribe(subscriber);

          scheduledJobs.set(jobName, { timerPetName, message, intervalMs, label: timerLabel, lastRun: null });
          // Persist all current schedules to schedules.json so the driver can
          // restore them on restart.
          await saveSchedules(scheduledJobs);
          console.log(`[tavern] Scheduled job "${jobName}" every ${minutes} min`);
          return `Schedule "${jobName}" created: you will receive "${message}" every ${minutes} minute(s). Use removeSchedule("${jobName}") to cancel.`;
        } catch (err) {
          return `Failed to create schedule: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
      help() {
        return 'Schedule a recurring job that wakes you with a new turn at a specified interval (minimum 60s). Persists across restarts. Use removeSchedule to cancel.';
      },
    }),
  );

  localTools.set(
    'removeSchedule',
    harden({
      schema() {
        return harden({
          type: 'function',
          function: {
            name: 'removeSchedule',
            description:
              'Cancel a scheduled job previously created with createSchedule. ' +
              'Cancels the underlying daemon timer and stops further ticks.',
            parameters: {
              type: 'object',
              properties: {
                jobName: {
                  type: 'string',
                  description: 'The job name to cancel.',
                },
              },
              required: ['jobName'],
            },
          },
        });
      },
      async execute(args) {
        const { jobName } = /** @type {{ jobName: string }} */ (args);
        if (!jobName) {
          return 'Error: jobName is required';
        }
        const info = scheduledJobs.get(jobName);
        const timerPetName = info ? info.timerPetName : `schedule-${jobName}`;
        scheduledJobs.delete(jobName);
        // Persist the updated set (without this job).
        await saveSchedules(scheduledJobs);
        const host = hostRef || powers;
        try {
          await E(host).cancel(timerPetName);
        } catch {
          // already cancelled or never existed
        }
        try {
          await E(host).remove(timerPetName);
        } catch {
          // best-effort
        }
        console.log(`[tavern] Removed schedule "${jobName}"`);
        return `Schedule "${jobName}" cancelled.`;
      },
      help() {
        return 'Cancel a scheduled job. Stops further ticks and cancels the daemon timer.';
      },
    }),
  );
  // --- end scheduled jobs ---

  // --- Context-management tools (summarization with LLM-verified commit) ---
  //
  // Disabled by default — enable via agent.json: `"enableSummarization": true`.
  // When disabled, none of the summary tools are registered and the budget
  // directive is not injected. See DESIGN.md §18.
  //
  // The LLM drives the flow: draftSummary → spawnProbeAgent → send probe questions
  // → inspect replies → commitSummary (or discardSummary to retry). Committing or
  // discarding auto-tears-down any spawned probe sub-agent. See DESIGN.md §18.
  //
  // `stagedSummary` is in-memory (lost on crash — the message re-runs, fine).
  // `probeLocators` maps probe handle-locator → probe petname so handleTurn can
  // format probe replies differently from normal inbox messages.

  let stagedSummary = null;
  /** @type {Map<string, string>} */
  const probeLocators = new Map();
  /** @type {Map<string, string>} probe petname → probe stateDir */
  const probeDirs = new Map();

  if (enableSummarization) {
  /**
   * Tear down a spawned probe sub-agent: cancel its formula, remove its
   * petnames, clean up the temp probe state dir. Idempotent.
   *
   * @param {string} probeName
   */
  const teardownProbe = async probeName => {
    const locator = [...probeLocators.entries()].find(([, n]) => n === probeName);
    if (locator) {
      probeLocators.delete(locator[0]);
    }
    probeDirs.delete(probeName);
    // Best-effort teardown — probes are never pinned, so a stale probe is
    // harmless if teardown fails; the destroy-agent CLI can clean up later.
    try {
      await E(powers).remove(probeName);
    } catch {
      // not registered in the parent's petstore, or already gone
    }
    if (factoryRef) {
      try {
        await E(factoryRef).destroyAgent(probeName);
      } catch {
        // already destroyed or factory unavailable
      }
    }
    // rm -rf the temp probe state dir
    const probeDir = path.join(stateDir, 'probes', probeName);
    try {
      await fsp.rm(probeDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  };

  localTools.set(
    'draftSummary',
    harden({
      schema() {
        return harden({
          type: 'function',
          function: {
            name: 'draftSummary',
            description:
              'Stage a summary of the conversation so far. The summary REPLACES older turns in future context (once committed), so include the essential facts, persona traits, and ongoing threads. After drafting, use spawnProbeAgent to verify, then commitSummary or discardSummary.',
            parameters: {
              type: 'object',
              properties: {
                summary: {
                  type: 'string',
                  description: 'The summary text. Include key facts, decisions, and persona traits.',
                },
              },
              required: ['summary'],
            },
          },
        });
      },
      async execute(args) {
        const { summary } = /** @type {{ summary: string }} */ (args);
        if (!summary || !summary.trim()) {
          return 'Error: summary text is required.';
        }
        stagedSummary = summary;
        return `Draft staged (${summary.length} chars). Use spawnProbeAgent to verify, commitSummary to finalize, or discardSummary to retry.`;
      },
      help() {
        return 'Stage a conversation summary for later commit. After drafting, verify with spawnProbeAgent, then commit or discard.';
      },
    }),
  );

  localTools.set(
    'spawnProbeAgent',
    harden({
      schema() {
        return harden({
          type: 'function',
          function: {
            name: 'spawnProbeAgent',
            description:
              'Spawn a transient sub-agent whose context mirrors what the parent ' +
              'will have after commitSummary: the same system prompt, PHI, and ' +
              'depth_prompt from agent.json, plus the staged summary as the effective ' +
              'conversation root. Send it questions via `send` to verify whether the ' +
              'summary preserves the character\'s personality in context. Use ' +
              'readProbeTrace to inspect its full thinking. Call this after draftSummary.',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        });
      },
      async execute(_args) {
        if (!stagedSummary) {
          return 'Error: no staged summary. Call draftSummary first.';
        }
        if (!factoryRef) {
          return 'Error: no factory available (running in restricted mode).';
        }
        const probeName = `${agentName}-probe-${Date.now()}`;
        const probeDir = path.join(stateDir, 'probes', probeName);
        await fsp.mkdir(probeDir, { recursive: true });

        // Write the probe's agent.json. The probe inherits the parent's
        // systemPrompt, PHI, and depthPrompt — exactly what the parent will
        // have after commitSummary (those are in agent.json, not in the tree,
        // so they survive summarization). The summary is seeded as the first
        // tree node (the effective root), matching what commitSummary appends.
        const parentCfg = await loadAgent(agentPath).catch(() => ({}));
        await saveJson(path.join(probeDir, 'agent.json'), harden({
          schemaVersion: 1,
          agentName: probeName,
          characterName: agentName,
          userName: 'Probe',
          personaDescription: parentCfg.personaDescription || '',
          systemPrompt: parentCfg.systemPrompt || '',
          postHistoryInstructions: parentCfg.postHistoryInstructions || '',
          depthPrompt: parentCfg.depthPrompt || null,
          promptInputs: { include: {}, useCardSystemPrompt: false, alternateGreetingIndex: 0 },
          promptHash: parentCfg.promptHash || '',
          provider: parentCfg.provider || { name: 'default' },
          model: parentCfg.model ?? null,
          importedAt: new Date().toISOString(),
          fsync: false,
          enableSummarization: false,
          contextBudgetTokens: CONTEXT_DEFAULTS.contextBudgetTokens,
          summarizeAtRatio: CONTEXT_DEFAULTS.summarizeAtRatio,
          summarizeDirective: CONTEXT_DEFAULTS.summarizeDirective,
        }));

        // Seed the probe's tree with the summary as the effective root —
        // a system message with metadata.summary = true, exactly matching
        // what commitSummary appends to the parent's tree. The probe's
        // context will then be: [parent's systemPrompt, summary node, ...]
        // — identical to the parent's post-commit state.
        const probeTreePath = path.join(probeDir, 'tree.jsonl');
        const probeBackend = await makeDiskBackend(probeTreePath, { fsync: false });
        const probeTree = makeConversationTree(probeBackend);
        const summaryContent = `[Summary of prior conversation:]\n${stagedSummary}`;
        await probeTree.addNode(
          null,
          [{ role: 'system', content: summaryContent }],
          { summary: true },
        );

        // Spawn the probe driver via the factory (not pinned — dies on restart)
        const profileName = await E(factoryRef).createAgent(probeName, {
          stateDir: probeDir,
          pin: false,
        });

        // Register the probe in the parent's petstore so the LLM can `send`
        // to it, and record its locator so handleTurn can format its replies.
        const probeLocator = await E(factoryRef).locateAgent(probeName);
        await E(powers).storeLocator(probeName, probeLocator);
        probeLocators.set(probeLocator, probeName);
        probeDirs.set(probeName, probeDir);

        return `Probe agent "${probeName}" spawned (profile: ${profileName}). It will announce when ready. Use send(to: "${probeName}", strings: ["your question"]) to verify the summary, then readProbeTrace to inspect its full thinking. When satisfied, call commitSummary; to retry, call discardSummary. Either will tear down the probe.`;
      },
      help() {
        return 'Spawn a transient verification sub-agent whose context is only your staged summary. Send it questions to check persona retention.';
      },
    }),
  );

  localTools.set(
    'readProbeTrace',
    harden({
      schema() {
        return harden({
          type: 'function',
          function: {
            name: 'readProbeTrace',
            description:
              'Read the full conversation trace of a probe sub-agent — every LLM call, ' +
              'tool call, and tool result, not just the final reply. Use this after sending ' +
              'a question to the probe (via send) to inspect whether the probe\'s personality ' +
              'and reasoning match the original character. The probe may still be running when ' +
              'you call this; you get its trace so far. Call multiple times to see updates.',
            parameters: {
              type: 'object',
              properties: {
                probeName: {
                  type: 'string',
                  description: 'The probe agent name (returned by spawnProbeAgent).',
                },
              },
              required: ['probeName'],
            },
          },
        });
      },
      async execute(args) {
        const { probeName } = /** @type {{ probeName: string }} */ (args);
        if (!probeName) {
          return 'Error: probeName is required';
        }
        const probeDir = probeDirs.get(probeName);
        if (!probeDir) {
          return `Error: unknown probe "${probeName}". Use the name returned by spawnProbeAgent.`;
        }
        const probeTreePath = path.join(probeDir, 'tree.jsonl');
        let text;
        try {
          text = await fsp.readFile(probeTreePath, 'utf8');
        } catch {
          return `Probe "${probeName}" has no conversation trace yet (it may still be starting up).`;
        }
        const lines = text.split('\n').filter(l => l.trim().length > 0);
        if (lines.length === 0) {
          return `Probe "${probeName}" has no conversation trace yet.`;
        }
        const parts = [];
        for (const line of lines) {
          try {
            const node = JSON.parse(line);
            for (const msg of node.messages) {
              const role = msg.role || 'unknown';
              if (msg.content) {
                parts.push(`[${role}] ${msg.content}`);
              }
              if (Array.isArray(msg.tool_calls)) {
                for (const tc of msg.tool_calls) {
                  const fn = tc.function || {};
                  parts.push(`[tool_call] ${fn.name}(${typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments)})`);
                }
              }
              if (msg.tool_call_id && msg.content) {
                parts.push(`[tool_result] ${msg.content}`);
              }
            }
          } catch {
            // skip unparseable
          }
        }
        const trace = parts.join('\n');
        if (!trace) {
          return `Probe "${probeName}" trace is empty.`;
        }
        return `=== Probe "${probeName}" trace (${lines.length} nodes) ===\n${trace}`;
      },
      help() {
        return 'Read the full conversation trace of a probe sub-agent (all LLM calls, tool calls, and results).';
      },
    }),
  );

  localTools.set(
    'commitSummary',
    harden({
      schema() {
        return harden({
          type: 'function',
          function: {
            name: 'commitSummary',
            description:
              'Commit the staged summary as a new effective root in the conversation tree. Older turns are omitted from future context (but retained on disk for audit). Tears down any spawned probe agent. Call this after you have verified the summary via spawnProbeAgent.',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        });
      },
      async execute(_args) {
        if (!stagedSummary) {
          return 'Error: no staged summary to commit.';
        }
        // Append the summary node as a child of the shared leaf. Its
        // metadata.summary flag marks it as the effective root for
        // getEffectivePath. The agentic loop continues from the summary
        // node, so its next step (tool results / final reply) is a CHILD
        // of the summary — keeping the summary on the path leaf → root.
        const summaryContent = `[Summary of prior conversation:]\n${stagedSummary}`;
        const node = await tree.addNode(
          sharedLeafId,
          [{ role: 'system', content: summaryContent }],
          { summary: true },
        );
        sharedLeafId = node.id;
        currentLeafId = node.id;

        // Tear down any spawned probe agent.
        for (const [, probeName] of probeLocators) {
          await teardownProbe(probeName);
        }

        const committed = stagedSummary;
        stagedSummary = null;
        return `Summary committed (${committed.length} chars). Older turns are omitted from future context; tree.jsonl retains them. Probe agent torn down.`;
      },
      help() {
        return 'Commit the staged summary as the effective conversation root, omitting older turns from future context.';
      },
    }),
  );

  localTools.set(
    'discardSummary',
    harden({
      schema() {
        return harden({
          type: 'function',
          function: {
            name: 'discardSummary',
            description:
              'Discard the staged summary and tear down any spawned probe agent. Call this to retry summarization with a fresh draft.',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        });
      },
      async execute(_args) {
        const had = stagedSummary !== null;
        stagedSummary = null;
        // Tear down any spawned probe agent.
        for (const [, probeName] of probeLocators) {
          await teardownProbe(probeName);
        }
        return had
          ? 'Draft discarded. Probe agent torn down. Call draftSummary to try again.'
          : 'Nothing to discard (no staged summary).';
      },
      help() {
        return 'Discard the staged summary and tear down any probe. Use to retry summarization.';
      },
    }),
  );
  // --- end context-management tools ---
  }

  const processToolCalls = async (toolCalls, toolMap) => {
    /** @type {object[]} */
    const results = [];
    for (const toolCall of toolCalls) {
      const { name, arguments: argsRaw } = /** @type {any} */ (toolCall)
        .function;

      /** @type {Record<string, unknown>} */
      let args;
      try {
        const jsonString =
          typeof argsRaw === 'string' ? argsRaw : JSON.stringify(argsRaw);
        args = decodeSmallcaps(jsonString);
      } catch {
        try {
          const jsonString =
            typeof argsRaw === 'string' ? argsRaw : JSON.stringify(argsRaw);
          args = JSON.parse(jsonString);
        } catch {
          args = {};
        }
      }

      console.log(`[tool] ${name}(${passableAsJustin(harden(args), false)})`);

      let result;
      try {
        result = await executeTool(name, args, toolMap);
        console.log(`[tool] ${name} -> ${passableAsJustin(result, false)}`);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        result = harden({ error: errorMessage });
        console.error(`[tool] ${name} error: ${errorMessage}`);
      }

      results.push({
        role: 'tool',
        content: passableAsJustin(result, false),
        tool_call_id: /** @type {any} */ (toolCall).id,
      });
    }

    return results;
  };

  /**
   * Run the agentic loop for one inbox message. Tool calls append assistant +
   * tool-result nodes to the disk tree; the loop ends on a no-tool-call
   * assistant message.
   *
   * @param {object[]} toolSchemas
   * @param {Map<string, object>} toolMap
   * @param {string} leafNodeId
   * @param {AgentConfig} cfg
   * @returns {Promise<string>} the final leaf id after the loop completes
   */
  const runAgenticLoop = async (toolSchemas, toolMap, leafNodeId, cfg) => {
    let currentSchemas = toolSchemas;
    let currentToolMap = toolMap;
    let continueLoop = true;
    sharedLeafId = leafNodeId;
    while (continueLoop) {
      const pathMessages = await getEffectivePath(tree, sharedLeafId);
      const messages = assembleContext(cfg, pathMessages);
      const est = estimateTokens(messages);

      console.log(
        `[tavern] context has ${messages.length} messages (≈${est} tokens), sending to LLM`,
      );
      const response = await chat(messages, currentSchemas);

      const { message: responseMessage } = response;
      if (!responseMessage) {
        break;
      }

      const rm = /** @type {any} */ (responseMessage);
      if ((!rm.tool_calls || rm.tool_calls.length === 0) && rm.content) {
        const extracted = extractToolCallsFromContent(rm.content);
        if (extracted.toolCalls) {
          rm.tool_calls = extracted.toolCalls;
          rm.content = extracted.cleanedContent;
        }
      }

      const toolCalls = Array.isArray(rm.tool_calls) ? rm.tool_calls : [];
      if (toolCalls.length !== 0) {
        const toolResults = await processToolCalls(toolCalls, currentToolMap);
        const maxChars = cfg.maxMessageChars ?? CONTEXT_DEFAULTS.maxMessageChars;
        const nodeMessages = truncateMessages(
          [responseMessage, ...toolResults],
          maxChars,
        );
        const stepNode = await tree.addNode(sharedLeafId, nodeMessages);
        sharedLeafId = stepNode.id;

        const needsRediscovery = toolCalls.some(
          tc => {
            const n = /** @type {any} */ (tc).function?.name;
            return n === 'adoptTool' || n === 'defineTool' || n === 'removeTool'
              || n === 'createSchedule' || n === 'removeSchedule';
          },
        );
        if (needsRediscovery) {
          const refreshed = await discoverTools(powers, localTools);
          currentSchemas = refreshed.schemas;
          currentToolMap = refreshed.toolMap;
        }
      } else {
        const maxChars = cfg.maxMessageChars ?? CONTEXT_DEFAULTS.maxMessageChars;
        const nodeMessages = truncateMessages([responseMessage], maxChars);
        const finalNode = await tree.addNode(sharedLeafId, nodeMessages);
        sharedLeafId = finalNode.id;
        continueLoop = false;
        if (rm.content) {
          console.log(`[tavern] ${rm.content}`);
        }
      }
    }
    return sharedLeafId;
  };

  const initializeIntroducedTools = async () => {
    try {
      await E(powers).makeDirectory(['tools']);
    } catch {
      // Already exists.
    }
    try {
      const topNames = /** @type {string[]} */ (await E(powers).list());
      console.log(`[tavern] top-level petnames: ${topNames.join(', ') || '(none)'}`);
      for (const name of topNames) {
        if (name !== 'tools' && !specialNamePattern.test(name)) {
          try {
            const entry = await E(powers).lookup([name]);
            await E(entry).schema();
            await E(entry).help();
            await E(powers).copy([name], ['tools', name]);
            await E(powers).remove(name);
            console.log(`[tavern] Moved introduced tool "${name}" into tools/`);
          } catch {
            // Not a FaeTool; leave it alone.
          }
        }
      }
    } catch (err) {
      console.error(
        '[tavern] initializeIntroducedTools: list() failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  const runAgent = async () => {
    await initializeIntroducedTools();
    await loadDefinedTools();
    await loadSchedules(hostRef);

    await E(powers).send('@host', [`Tavern agent "${agentName}" ready.`], [], []);

    const selfLocator = await E(powers).locate('@self');
    console.log(`[tavern] following inbox for "${agentName}" (self=${selfLocator})`);
    const cancelled = await getCancelled();
    const cancelledSignal = cancelled
      ? cancelled.then(
          () => ({ cancelled: true }),
          () => ({ cancelled: true }),
        )
      : null;

      const messageIterator = makeRefIterator(E(powers).followMessages());

    // Post-turn budget check, shared by handleTurn and handleScheduledTick.
    // If summarization is enabled and the context exceeds the configured
    // ratio, append a directive and run a self-turn.
    const maybeRunSummarizationTurn = async cfg => {
      if (!cfg.enableSummarization) return;
      const refreshed = await discoverTools(powers, localTools);
      const postPath = await getEffectivePath(tree, currentLeafId);
      const postMessages = assembleContext(cfg, postPath);
      const postEst = estimateTokens(postMessages);
      const budget = cfg.contextBudgetTokens ?? CONTEXT_DEFAULTS.contextBudgetTokens;
      const ratio = cfg.summarizeAtRatio ?? CONTEXT_DEFAULTS.summarizeAtRatio;
      if (postEst > ratio * budget) {
        const directiveTemplate = cfg.summarizeDirective ?? CONTEXT_DEFAULTS.summarizeDirective;
        const directive = buildDirective(directiveTemplate, postEst, budget);
        console.log(`[tavern] context over budget (≈${postEst}/${budget}), sending summarization directive as a self-turn`);
        const directiveNode = await tree.addNode(
          currentLeafId,
          [{ role: 'system', content: directive }],
          { directive: true },
        );
        currentLeafId = directiveNode.id;
        sharedLeafId = directiveNode.id;
        try {
          replyTracker.sent = false;
          currentLeafId = await runAgenticLoop(
            refreshed.schemas,
            refreshed.toolMap,
            directiveNode.id,
            cfg,
          );
        } catch (error2) {
          const msg2 = error2 instanceof Error ? error2.message : String(error2);
          console.error('[tavern] summarization self-turn error:', msg2);
        }
      }
    };

    // Handle a scheduled tick: append to tree and run agentic loop directly
    // (no inbox message, no reply/dismiss — same pattern as the summarization
    // self-turn).
    const handleScheduledTick = async tick => {
      let cfg;
      try {
        cfg = await loadAgent(agentPath);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error('[tavern] agent.json unreadable:', msg);
        return;
      }

      const { jobName, message: tickMessage } = tick;
      console.log(`[tavern] Scheduled tick from "${jobName}"`);
      const { schemas: toolSchemas, toolMap } = await discoverTools(
        powers,
        localTools,
      );
      console.log(`[tavern] ${toolSchemas.length} tools available (${[...toolMap.keys()].join(', ')})`);

      const node = await tree.addNode(
        currentLeafId,
        [{ role: 'user', content: tickMessage }],
        { scheduled: true, jobName },
      );
      currentLeafId = node.id;
      if (cfg.fsync) {
        fsync = true;
      }

      try {
        replyTracker.sent = false;
        currentLeafId = await runAgenticLoop(toolSchemas, toolMap, node.id, cfg);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        console.error(`[tavern] scheduled tick "${jobName}" error:`, errorMessage);
      }

      await maybeRunSummarizationTurn(cfg);
    };

    console.log(`[tavern] inbox iterator acquired; awaiting messages`);
    let pendingMessage = null;
    for (;;) {
      // Reset tick signal when the queue is empty so the next enqueueTick
      // can wake us.
      if (pendingTicks.length === 0) {
        tickSignal = makePromiseKit();
      }
      // Reuse the previous message promise if it wasn't consumed (e.g. a
      // tick won the race and the message may have resolved during tick
      // processing). Calling .next() again would skip the resolved value.
      if (!pendingMessage) {
        pendingMessage = messageIterator.next();
      }
      console.log(`[tavern] awaiting next message...`);
      const raced = cancelledSignal
        ? await Promise.race([
            cancelledSignal,
            pendingMessage.then(result => ({ cancelled: false, type: 'message', result })),
            tickSignal.promise.then(() => ({ cancelled: false, type: 'tick' })),
          ])
        : await Promise.race([
            pendingMessage.then(result => ({ cancelled: false, type: 'message', result })),
            tickSignal.promise.then(() => ({ cancelled: false, type: 'tick' })),
          ]);
      if (raced.cancelled) {
        try {
          await messageIterator.return?.();
        } catch {
          // ignore iterator return errors on cancellation
        }
        break;
      }
      if (raced.type === 'tick') {
        while (pendingTicks.length > 0) {
          const tick = pendingTicks.shift();
          await handleScheduledTick(tick);
        }
        // Keep pendingMessage — it may have resolved during tick processing,
        // in which case the next iteration's race resolves it immediately.
      } else {
        pendingMessage = null;
      const { value: message, done } = raced.result;
      if (done) {
        break;
      }
      const {
        from: fromId,
        number: rawNumber,
        type,
        strings,
        names,
      } = /** @type {any} */ (message);
      // `dismiss`/`reply` require the original BigInt; disk state needs a
      // JSON-safe Number. Keep both.
      const number = rawNumber;
      const messageNumber = Number(rawNumber);

      if (fromId === selfLocator) {
        /* self-delivered messages are our own sends — ignore */
      } else if (messageNumber < state.lastProcessedMessageNumber) {
        /* already fully handled in a prior session — skip */
      } else {
        // Re-read agent.json each turn so prompt edits take effect live (§4).
        const handleTurn = async () => {
          let cfg;
          try {
            cfg = await loadAgent(agentPath);
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[tavern] agent.json unreadable:', msg);
            await E(powers).reply(
              number,
              [`Tavern agent "${agentName}" has no agent.json (run the importer first).`],
              [],
              [],
            );
            // Leave it for retry; do not dismiss or advance.
            return;
          }

          console.log(`[tavern] New message #${number} from ${fromId}`);
          const { schemas: toolSchemas, toolMap } = await discoverTools(
            powers,
            localTools,
          );
          console.log(`[tavern] ${toolSchemas.length} tools available (${[...toolMap.keys()].join(', ')})`);

          let textContent;
          if (type === 'package' && Array.isArray(strings)) {
            const parts = [];
            const namesArray = Array.isArray(names) ? names : [];
            for (let i = 0; i < strings.length; i += 1) {
              parts.push(strings[i]);
              if (i < namesArray.length) {
                parts.push(`@${namesArray[i]}`);
              }
            }
            textContent = parts.join('').trim();
          } else {
            textContent = `(${type || 'unknown'} message)`;
          }

          // Probe replies are formatted differently so the LLM recognizes them
          // as verification data, not a user to converse with.
          const probeName = probeLocators.get(
            /** @type {string} */ (fromId),
          );
          const envelope = probeName
            ? `[Probe reply from ${probeName}] ${textContent}\n\nJudge whether the summary captured the persona, then commitSummary or discardSummary.`
            : `[Inbox message #${number}] ${textContent}\n\nUse reply(messageNumber: ${number}, ...) to respond to this message.`;

          // Idempotency / crash recovery (§10):
          //  - if the current leaf is already this turn's user node, resume
          //    from it (a prior loop was interrupted before posting an
          //    assistant reply) instead of re-appending;
          //  - if it is this turn's user node AND already has an assistant
          //    child, the turn was fully handled — dismiss and skip.
          let userNodeId = null;
          const leafNode =
            currentLeafId === null ? null : await tree.getNode(currentLeafId);
          const isResumeTarget =
            leafNode !== null &&
            leafNode.messages.some(msg => msg.role === 'user') &&
            leafNode.metadata &&
            leafNode.metadata.messageNumber === messageNumber;

          if (isResumeTarget) {
            const children = await tree.getChildren(currentLeafId);
            const answered = children.some(c =>
              c.messages.some(msg => msg.role === 'assistant'),
            );
            if (answered) {
              await E(powers).dismiss(number);
              if (messageNumber > state.lastProcessedMessageNumber) {
                state.lastProcessedMessageNumber = messageNumber;
                await saveState(statePath, state);
              }
              return;
            }
            userNodeId = currentLeafId;
          } else {
            const node = await tree.addNode(
              currentLeafId,
              [{ role: 'user', content: envelope }],
              { messageNumber },
            );
            userNodeId = node.id;
            currentLeafId = node.id;
            if (cfg.fsync) {
              fsync = true;
            }
          }

          // Advance lastProcessedMessageNumber BEFORE the LLM loop so a crash
          // mid-reply does not re-append the user turn (§10).
          if (messageNumber > state.lastProcessedMessageNumber) {
            state.lastProcessedMessageNumber = messageNumber;
            await saveState(statePath, state);
          }

          try {
            replyTracker.sent = false;
            currentLeafId = await runAgenticLoop(
              toolSchemas,
              toolMap,
              userNodeId,
              cfg,
            );

            if (!replyTracker.sent) {
              const finalNode = await tree.getNode(currentLeafId);
              if (finalNode) {
                const lastMsg =
                  finalNode.messages[finalNode.messages.length - 1];
                if (lastMsg && lastMsg.role === 'assistant' && lastMsg.content) {
                  console.log('[tavern] No reply tool called, sending fallback reply');
                  await E(powers).reply(number, [lastMsg.content], [], []);
                }
              }
            }

            await E(powers).dismiss(number);
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            console.error('[tavern] LLM error, notifying sender:', errorMessage);
            // Do NOT dismiss — leave the message for retry (§10).
            try {
              await E(powers).reply(number, [errorMessage], [], []);
            } catch {
              // best-effort
            }
          }

          // Post-turn budget check: if summarization is enabled and the
          // context now exceeds the configured ratio, append a directive
          // as the latest message in the tree and immediately run a
          // self-turn (no inbox message) so the agent can summarize before
          // the next user message arrives.
          await maybeRunSummarizationTurn(cfg);
        };
        await handleTurn();
      }
      }
    }
  };

  await runAgent();
};
harden(spawnTavernLoop);

// ============================================================================
// Tavern Factory — Entry Point
// ============================================================================

const driverSpecifier = new URL('driver.js', import.meta.url).href;

/**
 * A narrowed facet over EndoHost that exposes ONLY the timer-related methods
 * the schedule tools need: makeTimer, lookup, cancel, remove. This prevents
 * the agent from gaining broader host powers (provideGuest, makeUnconfined,
 * etc.) through the schedule capability. Exported so the grant-scheduling
 * script can create the same narrowed facet for existing agents.
 */
const TimerHostInterface = M.interface('TimerHost', {
  makeTimer: M.call(M.string(), M.number())
    .optional(M.string())
    .returns(M.promise()),
  lookup: M.call(M.any()).returns(M.promise()),
  cancel: M.call(M.any()).optional(M.any()).returns(M.promise()),
  remove: M.call(M.any()).returns(M.promise()),
});

export const makeTimerHost = hostRef =>
  makeExo('TimerHost', TimerHostInterface, {
    makeTimer(petName, intervalMs, label) {
      return E(hostRef).makeTimer(petName, intervalMs, label);
    },
    lookup(namePath) {
      return E(hostRef).lookup(namePath);
    },
    cancel(name, reason) {
      return E(hostRef).cancel(name, reason);
    },
    remove(name) {
      return E(hostRef).remove(name);
    },
  });

/**
 * Creates a Tavern factory that provisions agent instances bound to a named
 * LLM provider. `createAgent(name, { stateDir, providerName?, pin? })` does
 * NOT take a system prompt — the prompt lives on disk in `agent.json`, which
 * is exactly what lets prompts change without recreating the agent (§4).
 *
 * @param {import('@endo/eventual-send').FarRef<object>} guestPowers
 * @param {Promise<object> | object | undefined} _context
 * @returns {Promise<object>}
 */
// eslint-disable-next-line no-underscore-dangle
export const make = async (guestPowers, _context) => {
  /** @type {any} */
  const powers = guestPowers;

  const hostAgent = await E(powers).lookup('host-agent');

  return makeExo('TavernFactory', TavernFactoryInterface, {
    /**
     * Create a new agent instance bound to an existing on-disk state dir.
     *
     * `agent.json` must already exist (run the importer first). The driver
     * reads `systemPrompt`/`providerName`/`fsync` from there each turn.
     *
     * @param {string} name - agent name (matches the on-disk subdir)
     * @param {object} [options]
     * @param {string} [options.stateDir] - absolute path to the agent state dir
     * @param {string} [options.providerName] - stored provider name (default "default")
     * @param {boolean} [options.pin] - pin the driver to PINS for restart survival
     * @returns {Promise<string>} the agent's profile petname
     */
    async createAgent(name, options = {}) {
      const { stateDir, providerName, pin } =
        /** @type {{ stateDir?: string, providerName?: string, pin?: boolean }} */ (
          options
        );

      if (!stateDir) {
        throw new Error(
          'createAgent requires { stateDir } — run the importer first and pass the resolved state dir.',
        );
      }

      const guestName = name;
      const profileName = `profile-for-${guestName}`;
      const driverHandleName = `${name}-driver-handle`;
      const driverProfileName = `profile-for-${driverHandleName}`;
      const driverResultName = `${name}-driver`;

      if (await E(hostAgent).has(driverResultName)) {
        throw new Error(`Agent "${name}" already exists.`);
      }

      // 1. Create the agent guest (inbox, petstore, tools).
      const hasAgent = await E(hostAgent).has(guestName);
      if (!hasAgent) {
        await E(hostAgent).provideGuest(guestName, {
          agentName: profileName,
        });
      }

      // 2. Create a lightweight driver guest whose namespace holds the
      //    capability refs to the provider config and the agent. Guard with
      //    has(): a reincarnated handle formula lacks `write`, so provideGuest
      //    on an already-existing guest can fail on restart.
      const hasDriverHandle = await E(hostAgent).has(driverHandleName);
      if (!hasDriverHandle) {
        await E(hostAgent).provideGuest(driverHandleName, {
          agentName: driverProfileName,
        });
      }

      // 3. Write capability references into the driver's namespace. Use
      //    lookup(profileName) + storeIdentifier (not the provideGuest return
      //    value, which is a mailbox Handle with only open/receive).
      const driverPowers = await E(hostAgent).lookup(driverProfileName);
      const providerId = await E(powers).identify('llm-provider');
      await E(driverPowers).storeIdentifier('llm-provider', providerId);

      const agentId = await E(hostAgent).identify(profileName);
      await E(driverPowers).storeIdentifier('agent', agentId);

      // Also store the factory's own self-ref so the driver's summary tools
      // can spawn/tear down probe sub-agents via the factory.
      const factoryLocator = await E(powers).locate('@self');
      await E(driverPowers).storeLocator('tavern-factory', factoryLocator);

      // Store the raw host-agent identifier in the driver's petstore.
      // The driver narrows it to TimerHost at startup (makeTimerHost) so the
      // schedule tools can't reach broader host powers (provideGuest,
      // makeUnconfined, etc.). The agent can't lookup('host-agent') — it's
      // in the DRIVER's petstore, not the agent's.
      const hostAgentId = await E(powers).identify('host-agent');
      await E(driverPowers).storeIdentifier('host-agent', hostAgentId);

      // 4. Launch the driver caplet, passing the disk state dir + agent name
      //    via env so it can reload agent.json / tree.jsonl each turn.
      await E(hostAgent).makeUnconfined('@main', driverSpecifier, {
        powersName: driverProfileName,
        resultName: driverResultName,
        env: harden({
          TAVERN_STATE_DIR: stateDir,
          TAVERN_AGENT_NAME: name,
          TAVERN_PROVIDER_NAME: providerName || 'default',
        }),
      });

      // 5. Pin the driver so it auto-restarts on daemon reboot.
      if (pin) {
        await E(hostAgent).copy([driverResultName], ['@pins', driverResultName]);
        console.log(`[tavern-factory] Pinned driver "${driverResultName}"`);
      }

      console.log(`[tavern-factory] Created agent "${name}"`);
      return profileName;
    },

    /**
     * Tear down a tavern agent: cancel its driver formula + forget its
     * petnames. Idempotent. Used by the summary tools to tear down probe
     * sub-agents, and also useful for manual agent cleanup.
     *
     * @param {string} name - the agent name (same as passed to createAgent)
     * @returns {Promise<string>}
     */
    async destroyAgent(name) {
      const guestName = name;
      const profileName = `profile-for-${guestName}`;
      const driverHandleName = `${name}-driver-handle`;
      const driverProfileName = `profile-for-${driverHandleName}`;
      const driverResultName = `${name}-driver`;

      // Cancel the driver formula (stops the running caplet + its deps).
      try {
        await E(hostAgent).cancel(driverResultName);
      } catch {
        // already gone or never existed
      }

      // Forget all petnames (idempotent — has-guard each).
      for (const petName of [
        driverResultName,
        `@pins/${driverResultName}`,
        guestName,
        profileName,
        driverHandleName,
        driverProfileName,
      ]) {
        if (await E(hostAgent).has(petName).catch(() => false)) {
          await E(hostAgent).remove(petName).catch(() => {});
        }
      }

      console.log(`[tavern-factory] Destroyed agent "${name}"`);
      return `Destroyed "${name}"`;
    },

    /**
     * Resolve an agent's handle locator. Used by the summary tools to
     * register a probe sub-agent in the parent's petstore so the LLM can
     * `send` to it.
     *
     * @param {string} name - the agent name
     * @returns {Promise<string>}
     */
    async locateAgent(name) {
      const profileName = `profile-for-${name}`;
      return E(hostAgent).locate(profileName);
    },

    /**
     * @param {string} [methodName]
     * @returns {string}
     */
    help(methodName) {
      if (methodName === undefined) {
        return 'Tavern factory: runs SillyTavern character cards as Endo agents with disk-backed conversation history. Use createAgent(name, { stateDir, providerName?, pin }) to bind a driver to an existing on-disk state dir. Use destroyAgent(name) to tear down an agent.';
      }
      if (methodName === 'createAgent') {
        return 'createAgent(name, { stateDir, providerName?, pin? }) — Bind a driver caplet to an existing on-disk state dir (run the importer first). Pass pin: true to survive daemon restarts. Returns the profile petname.';
      }
      if (methodName === 'destroyAgent') {
        return 'destroyAgent(name) — Cancel the driver, forget petnames. Idempotent. Also used internally by summary verification to tear down probe sub-agents.';
      }
      if (methodName === 'locateAgent') {
        return 'locateAgent(name) — Resolve an agent handle locator. Used internally to register probe sub-agents.';
      }
      return `No documentation for method "${methodName}".`;
    },
  });
};
harden(make);