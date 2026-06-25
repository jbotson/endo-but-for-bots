// @ts-nocheck - E() generics don't work well with JSDoc types for remote objects
/* eslint-disable no-await-in-loop, @endo/restrict-comparison-operands */

import path from 'node:path';

import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { E } from '@endo/eventual-send';
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
  makeExecTool,
  makeReadChannelTool,
} from './src/tool-makers.js';
import { makeDiskBackend } from './src/disk-backend.js';
import {
  loadAgent,
  loadState,
  saveState,
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
  while (msgs.length > 0 && msgs[0].role === 'system') {
    msgs.shift();
  }
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
 * @returns {Promise<void>}
 */
export const spawnTavernLoop = async (
  powers,
  context,
  providerConfig,
  stateDir,
  agentName,
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

  const provider =
    providerConfig.provider ||
    createProvider({
      LAL_HOST: providerConfig.host,
      LAL_MODEL: providerConfig.model,
      LAL_AUTH_TOKEN: providerConfig.authToken,
    });

  const chat = (messages, toolSchemas) => provider.chat(messages, toolSchemas);

  let fsync = false;
  try {
    const startup = await loadAgent(agentPath);
    fsync = Boolean(startup.fsync);
  } catch (error) {
    console.error(
      `[tavern] agent.json unreadable at startup: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const backend = await makeDiskBackend(treePath, { fsync });
  const tree = makeConversationTree(backend);

  let currentLeafId = await resolveCurrentLeaf(tree);

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
  localTools.set('exec', makeExecTool(powers));
  localTools.set('readChannel', makeReadChannelTool(powers));

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
    let currentLeafIdLocal = leafNodeId;
    let currentSchemas = toolSchemas;
    let currentToolMap = toolMap;
    let continueLoop = true;
    while (continueLoop) {
      const pathMessages = await tree.getPath(currentLeafIdLocal);
      const messages = assembleContext(cfg, pathMessages);
      console.log(
        `[tavern] context has ${messages.length} messages, sending to LLM`,
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
        const stepNode = await tree.addNode(currentLeafIdLocal, [
          responseMessage,
          ...toolResults,
        ]);
        currentLeafIdLocal = stepNode.id;

        const adopted = toolCalls.some(
          tc => /** @type {any} */ (tc).function?.name === 'adoptTool',
        );
        if (adopted) {
          const refreshed = await discoverTools(powers, localTools);
          currentSchemas = refreshed.schemas;
          currentToolMap = refreshed.toolMap;
        }
      } else {
        const finalNode = await tree.addNode(currentLeafIdLocal, [
          responseMessage,
        ]);
        currentLeafIdLocal = finalNode.id;
        continueLoop = false;
        if (rm.content) {
          console.log(`[tavern] ${rm.content}`);
        }
      }
    }
    return currentLeafIdLocal;
  };

  const initializeIntroducedTools = async () => {
    try {
      await E(powers).makeDirectory(['tools']);
    } catch {
      // Already exists.
    }
    try {
      const topNames = /** @type {string[]} */ (await E(powers).list());
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
    } catch {
      // list() failed; skip initialization.
    }
  };

  const runAgent = async () => {
    await initializeIntroducedTools();

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
    console.log(`[tavern] inbox iterator acquired; awaiting messages`);
    for (;;) {
      const nextMessage = messageIterator.next();
      console.log(`[tavern] awaiting next message...`);
      const raced = cancelledSignal
        ? await Promise.race([
            cancelledSignal,
            nextMessage.then(result => ({ cancelled: false, result })),
          ])
        : { cancelled: false, result: await nextMessage };
      if (raced.cancelled) {
        try {
          await messageIterator.return?.();
        } catch {
          // ignore iterator return errors on cancellation
        }
        break;
      }
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

          const envelope = `[Inbox message #${number}] ${textContent}\n\nUse reply(messageNumber: ${number}, ...) to respond to this message.`;

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
        };
        await handleTurn();
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
     * @param {string} [methodName]
     * @returns {string}
     */
    help(methodName) {
      if (methodName === undefined) {
        return 'Tavern factory: runs SillyTavern character cards as Endo agents with disk-backed conversation history. Use createAgent(name, { stateDir, providerName?, pin }) to bind a driver to an existing on-disk state dir.';
      }
      if (methodName === 'createAgent') {
        return 'createAgent(name, { stateDir, providerName?, pin? }) — Bind a driver caplet to an existing on-disk state dir (run the importer first). Pass pin: true to survive daemon restarts. Returns the profile petname.';
      }
      return `No documentation for method "${methodName}".`;
    },
  });
};
harden(make);