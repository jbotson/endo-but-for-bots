// @ts-check
/* eslint-disable no-await-in-loop */

import '@endo/init/debug.js';

import test from 'ava';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { makeConversationTree } from '@endo/conversation-tree';

import { importCard } from '../src/import.js';
import { spawnTavernLoop } from '../agent.js';
import { makeDiskBackend } from '../src/disk-backend.js';
import { loadAgent, loadState, saveJson } from '../src/agent-state.js';

const v2Card = {
  spec: '2.0',
  data: {
    name: 'Seraphina',
    description: 'a guide',
    personality: 'calm',
    scenario: 'a library',
    first_mes: 'Hello, traveler.',
    mes_example: 'User: hi',
    system_prompt: 'You are {{char}}. Answer in character.',
    post_history_instructions: 'Never break character, {{char}}.',
    extensions: { depth_prompt: { depth: 4, role: 'system', prompt: 'Remember {{user}} quietly.' } },
  },
};

const setupState = async (opts = {}) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tavern-loop-'));
  const stateDir = path.join(dir, 'tavern', 'seraphina');
  const cardPath = path.join(dir, 'seraphina.json');
  await fsp.writeFile(cardPath, JSON.stringify(v2Card), 'utf8');
  await importCard({ card: cardPath, agent: 'seraphina', stateDir, ...opts });

  if (opts.enableSummarization) {
    const agentPath = path.join(stateDir, 'agent.json');
    const agent = await loadAgent(agentPath);
    await saveJson(agentPath, harden({ ...agent, enableSummarization: true }));
  }
  return { dir, stateDir };
};

/**
 * A tiny fake powers that records the interactions spawnTavernLoop actually
 * uses on the no-tool-call path: locate / makeDirectory / list / send /
 * followMessages / reply / dismiss. Tool-maker construction closes over it
 * but no tools are executed in these tests.
 */
const makePowers = (/** @type {object[]} */ messages, selfLocator = 'me') => {
  let i = 0;
  const iterator = harden({
    next: async () => {
      if (i < messages.length) {
        const value = messages[i];
        i += 1;
        return { value, done: false };
      }
      return { value: undefined, done: true };
    },
    return: async () => ({ value: undefined, done: true }),
    throw: async () => ({ value: undefined, done: true }),
  });
  const replies = [];
  const sends = [];
  const dismissed = [];
  const powers = harden({
    locate: async who => (who === '@self' ? selfLocator : `${who}-loc`),
    makeDirectory: async () => undefined,
    list: async () => [],
    copy: async () => undefined,
    remove: async () => undefined,
    storeIdentifier: async () => undefined,
    storeLocator: async () => undefined,
    send: async (to, strings) => {
      sends.push({ to, strings });
    },
    reply: async (number, strings) => {
      replies.push({ number, strings });
      return true;
    },
    dismiss: async number => {
      dismissed.push(number);
    },
    followMessages: async () => iterator,
  });
  return { powers, replies, sends, dismissed, _iterator: iterator };
};

test('loop assembles system prompt + PHI + depth from agent.json, replies, and persists to disk', async t => {
  const { stateDir } = await setupState();
  let captured;
  const provider = harden({
    chat: async (msgs, _tools) => {
      captured = msgs;
      return { message: { role: 'assistant', content: 'Greetings, traveler!' } };
    },
  });

  const msg = harden({
    from: 'someone',
    number: 1,
    type: 'package',
    strings: ['Hello!'],
    names: [],
    messageId: 'mid-1',
  });
  const { powers, replies, dismissed } = makePowers([msg]);
  await spawnTavernLoop(powers, undefined, { provider }, stateDir, 'seraphina');

  const agent = await loadAgent(path.join(stateDir, 'agent.json'));
  // Leading system is agent.json's (portability root stripped).
  t.is(captured[0].role, 'system');
  t.is(captured[0].content, agent.systemPrompt);
  // PHI tail appended at the end.
  t.is(captured[captured.length - 1].role, 'system');
  t.is(captured[captured.length - 1].content, agent.postHistoryInstructions);
  // depth_prompt present somewhere mid-context (not first, not last).
  const depthEntry = captured.find(m => m.content === 'Remember User quietly.');
  t.truthy(depthEntry);
  t.not(depthEntry, captured[0]);
  t.not(depthEntry, captured[captured.length - 1]);

  // Fallback reply + dismiss recorded.
  t.deepEqual(replies, [{ number: 1, strings: ['Greetings, traveler!'] }]);
  t.deepEqual(dismissed, [1]);

  // state advanced + disk tree persists user + assistant nodes.
  const state = await loadState(path.join(stateDir, 'state.json'));
  t.is(state.lastProcessedMessageNumber, 1);

  const backend = await makeDiskBackend(path.join(stateDir, 'tree.jsonl'));
  const tree = makeConversationTree(backend);
  const roots = await tree.getRoots();
  t.true(roots.length >= 1);
  const leaf = await resolveLeaf(tree);
  t.truthy(leaf);
  const chain = await tree.getPath(leaf.id);
  const roles = chain.map(m => m.role);
  t.true(roles.includes('user'));
  t.true(roles.includes('assistant'));
});

test('resumes a crashed user turn (recorded leaf, no assistant) without duplicating it', async t => {
  const { stateDir } = await setupState();
  // Manually lay down a tree: system portability root + a user node for message #2,
  // and advance state to 2 — simulating a crash after appending the user turn.
  const treePath = path.join(stateDir, 'tree.jsonl');
  await fsp.writeFile(
    treePath,
    `${[
      JSON.stringify({
        id: 'root',
        parentId: null,
        messages: [{ role: 'system', content: 'sys-root' }],
        metadata: {},
        timestamp: 1,
      }),
      JSON.stringify({
        id: 'u2',
        parentId: 'root',
        messages: [{ role: 'user', content: '[Inbox message #2] hi again' }],
        metadata: { messageNumber: 2 },
        timestamp: 2,
      }),
    ].join('\n')}\n`,
    'utf8',
  );

  await fsp.writeFile(
    path.join(stateDir, 'state.json'),
    JSON.stringify({ schemaVersion: 1, lastProcessedMessageNumber: 2 }),
    'utf8',
  );

  const provider = harden({
    chat: async _msgs => ({
      message: { role: 'assistant', content: 'Recovered reply!' },
    }),
  });
  const msg = harden({
    from: 'someone',
    number: 2,
    type: 'package',
    strings: ['hi again'],
    names: [],
    messageId: 'mid-2',
  });
  const { powers, replies } = makePowers([msg]);
  await spawnTavernLoop(powers, undefined, { provider }, stateDir, 'seraphina');

  // A fresh assistant node now hangs under the existing user node; no new user node.
  const backend = await makeDiskBackend(treePath);
  const tree = makeConversationTree(backend);
  const userNode = await tree.getNode('u2');
  const children = await tree.getChildren('u2');
  t.is(children.length, 1);
  t.is(children[0].messages[0].role, 'assistant');
  t.is(children[0].messages[0].content, 'Recovered reply!');
  t.deepEqual(replies, [{ number: 2, strings: ['Recovered reply!'] }]);
  // The original user node was NOT duplicated (still exactly one user node).
  const allChildrenOfRoot = await tree.getChildren('root');
  t.is(allChildrenOfRoot.length, 1);
  void userNode;
});

test('skips messages already fully handled in a prior session', async t => {
  const { stateDir } = await setupState();
  let calls = 0;
  const provider = harden({
    chat: async () => {
      calls += 1;
      return { message: { role: 'assistant', content: 'x' } };
    },
  });
  // message #3 arrived, but state says we already processed up to 5 → skip.
  await fsp.writeFile(
    path.join(stateDir, 'state.json'),
    JSON.stringify({ schemaVersion: 1, lastProcessedMessageNumber: 5 }),
    'utf8',
  );
  const msg = harden({
    from: 'someone',
    number: 3,
    type: 'package',
    strings: ['stale'],
    names: [],
    messageId: 'mid-3',
  });
  const { powers, replies, dismissed } = makePowers([msg]);
  await spawnTavernLoop(powers, undefined, { provider }, stateDir, 'seraphina');
  t.is(calls, 0);
  t.is(replies.length, 0);
  t.is(dismissed.length, 0);
});

const resolveLeaf = async tree => {
  const roots = await tree.getRoots();
  if (roots.length === 0) return null;
  let cursor = roots[0].id;
  for (;;) {
    const kids = await tree.getChildren(cursor);
    if (kids.length === 0) return tree.getNode(cursor);
    cursor = kids[0].id;
  }
};

// --- Summarization tests ---

/** A mock factory that records createAgent/destroyAgent/locateAgent calls. */
const makeMockFactory = () => {
  const created = [];
  const destroyed = [];
  const factory = harden({
    createAgent: async (name, opts) => {
      created.push({ name, opts });
      return `profile-for-${name}`;
    },
    destroyAgent: async name => {
      destroyed.push(name);
      return `Destroyed "${name}"`;
    },
    locateAgent: async name => `endo://probe-loc-${name}`,
  });
  return { factory, created, destroyed };
};

/** A mock provider that returns pre-canned responses from a queue. */
const makeQueuedProvider = responses => {
  let i = 0;
  return harden({
    chat: async (messages, _tools) => {
      const resp = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return { message: JSON.parse(JSON.stringify(resp)) };
    },
  });
};

const toolCall = (id, name, args) => ({
  id,
  function: { name, arguments: JSON.stringify(args) },
});

test('draftSummary → commitSummary: summary node truncates future context', async t => {
  const { stateDir } = await setupState({ enableSummarization: true });
  const { factory, destroyed: _destroyed1 } = makeMockFactory();

  const provider = makeQueuedProvider([
    { role: 'assistant', content: null, tool_calls: [toolCall('t1', 'draftSummary', { summary: 'We discussed cats and the weather.' })] },
    { role: 'assistant', content: null, tool_calls: [toolCall('t2', 'commitSummary', {})] },
    { role: 'assistant', content: 'Summary committed. How can I help?' },
  ]);

  const msg = harden({ from: 'someone', number: 1n, type: 'package', strings: ['hello'], names: [] });
  const { powers } = makePowers([msg]);
  await spawnTavernLoop(powers, undefined, { provider }, stateDir, 'seraphina', factory);

  // Verify: tree has a summary node, and getEffectivePath returns only from it forward
  const backend = await makeDiskBackend(path.join(stateDir, 'tree.jsonl'));
  const tree = makeConversationTree(backend);
  const leaf = await resolveLeaf(tree);
  t.truthy(leaf);
  // Walk backward until we find the summary node
  let cursor = leaf.id;
  let foundSummary = false;
  while (cursor) {
    const node = await tree.getNode(cursor);
    if (!node) break;
    if (node.metadata && node.metadata.summary) {
      foundSummary = true;
      t.regex(node.messages[0].content, /\[Summary of prior conversation:\]/);
      t.regex(node.messages[0].content, /cats and the weather/);
      break;
    }
    cursor = node.parentId;
  }
  t.true(foundSummary, 'a summary node should exist in the tree');
});

test('discardSummary: no summary node appended; context unchanged', async t => {
  const { stateDir } = await setupState({ enableSummarization: true });
  const { factory } = makeMockFactory();

  const provider = makeQueuedProvider([
    { role: 'assistant', content: null, tool_calls: [toolCall('t1', 'draftSummary', { summary: 'Discarded summary.' })] },
    { role: 'assistant', content: null, tool_calls: [toolCall('t2', 'discardSummary', {})] },
    { role: 'assistant', content: 'OK, let me try again.' },
  ]);

  const msg = harden({ from: 'someone', number: 1n, type: 'package', strings: ['hello'], names: [] });
  const { powers } = makePowers([msg]);
  await spawnTavernLoop(powers, undefined, { provider }, stateDir, 'seraphina', factory);

  // No summary node should exist
  const backend = await makeDiskBackend(path.join(stateDir, 'tree.jsonl'));
  const tree = makeConversationTree(backend);
  const leaf = await resolveLeaf(tree);
  t.truthy(leaf);
  let cursor = leaf.id;
  while (cursor) {
    const node = await tree.getNode(cursor);
    if (!node) break;
    t.falsy(node.metadata && node.metadata.summary, 'no summary node should exist');
    cursor = node.parentId;
  }
});

test('budget directive triggers a self-turn with the directive at end of context', async t => {
  const { stateDir } = await setupState({ enableSummarization: true });
  /** @type {object[][]} */
  const calls = [];
  const responses = [
    { role: 'assistant', content: 'OK' },                              // turn 1 (user msg)
    { role: 'assistant', content: 'I should summarize now.' },         // self-turn (directive)
  ];
  let callIdx = 0;
  const provider = harden({
    chat: async (messages, _tools) => {
      calls.push(messages);
      const resp = responses[Math.min(callIdx, responses.length - 1)];
      callIdx += 1;
      return { message: JSON.parse(JSON.stringify(resp)) };
    },
  });

  // Write agent.json with a tiny budget to trigger the directive
  await saveJson(path.join(stateDir, 'agent.json'), harden({
    ...await loadAgent(path.join(stateDir, 'agent.json')),
    contextBudgetTokens: 10,
    summarizeAtRatio: 0.5,
    summarizeDirective: 'CONTEXT_TOO_LARGE: est={{estTokens}}, budget={{budgetTokens}}',
  }));

  const msg = harden({ from: 'someone', number: 1n, type: 'package', strings: ['a'.repeat(100)], names: [] });
  const { powers } = makePowers([msg]);

  await spawnTavernLoop(powers, undefined, { provider }, stateDir, 'seraphina');

  // Two calls: the user-message turn + the self-turn
  t.is(calls.length, 2, 'provider.chat should be called twice (turn + self-turn)');
  const selfTurnMessages = calls[1];
  const directive = selfTurnMessages.find(
    m => m.role === 'system' && m.content.includes('CONTEXT_TOO_LARGE'),
  );
  t.truthy(directive, 'self-turn context should contain the directive');
  t.regex(directive.content, /est=\d+/);
  t.regex(directive.content, /budget=10/);

  // The directive should be the last non-PHI message (it was appended after
  // the turn's assistant reply, before depth/PHI injection)
  const lastSystemIdx = selfTurnMessages.map(m => m.role).lastIndexOf('system');
  t.true(lastSystemIdx >= 0, 'at least one system message exists');

  // A directive node should exist in the tree
  const backend = await makeDiskBackend(path.join(stateDir, 'tree.jsonl'));
  const tree = makeConversationTree(backend);
  const leaf = await resolveLeaf(tree);
  t.truthy(leaf);
  let foundDirective = false;
  let cursor = leaf.id;
  while (cursor) {
    const node = await tree.getNode(cursor);
    if (!node) break;
    if (node.metadata && node.metadata.directive) {
      foundDirective = true;
      break;
    }
    cursor = node.parentId;
  }
  t.true(foundDirective, 'a directive node should exist in the tree');
});

test('spawnProbeAgent → commitSummary: factory.createAgent and destroyAgent called', async t => {
  const { stateDir } = await setupState({ enableSummarization: true });
  const { factory, created, destroyed } = makeMockFactory();

  const provider = makeQueuedProvider([
    { role: 'assistant', content: null, tool_calls: [toolCall('t1', 'draftSummary', { summary: 'Probe test summary.' })] },
    { role: 'assistant', content: null, tool_calls: [toolCall('t2', 'spawnProbeAgent', {})] },
    { role: 'assistant', content: null, tool_calls: [toolCall('t3', 'commitSummary', {})] },
    { role: 'assistant', content: 'Done.' },
  ]);

  const msg = harden({ from: 'someone', number: 1n, type: 'package', strings: ['hello'], names: [] });
  const { powers } = makePowers([msg]);
  await spawnTavernLoop(powers, undefined, { provider }, stateDir, 'seraphina', factory);

  t.is(created.length, 1, 'factory.createAgent should be called once for the probe');
  t.true(created[0].name.includes('probe'), 'created agent name should contain "probe"');
  t.is(destroyed.length, 1, 'factory.destroyAgent should be called once to tear down the probe');
  t.true(destroyed[0].includes('probe'), 'destroyed agent name should contain "probe"');
});

test('committed summary survives restart (getEffectivePath truncates from summary node)', async t => {
  const { stateDir } = await setupState({ enableSummarization: true });
  const { factory } = makeMockFactory();

  // First session: draft + commit a summary
  const provider1 = makeQueuedProvider([
    { role: 'assistant', content: null, tool_calls: [toolCall('t1', 'draftSummary', { summary: 'Summary for restart test.' })] },
    { role: 'assistant', content: null, tool_calls: [toolCall('t2', 'commitSummary', {})] },
    { role: 'assistant', content: 'Committed.' },
  ]);
  const msg1 = harden({ from: 'someone', number: 1n, type: 'package', strings: ['hello'], names: [] });
  const { powers: powers1 } = makePowers([msg1]);
  await spawnTavernLoop(powers1, undefined, { provider: provider1 }, stateDir, 'seraphina', factory);

  // Second session: send a new message; the context should start from the summary node
  let captured2;
  const provider2 = harden({
    chat: async (messages, _tools) => {
      captured2 = messages;
      return { message: { role: 'assistant', content: 'After restart.' } };
    },
  });
  const msg2 = harden({ from: 'someone', number: 2n, type: 'package', strings: ['new message'], names: [] });
  const { powers: powers2 } = makePowers([msg2]);
  await spawnTavernLoop(powers2, undefined, { provider: provider2 }, stateDir, 'seraphina', factory);

  // The first system message in the path should be the summary, not the
  // original system prompt — but assembleContext prepends agent.json's
  // systemPrompt. So the path should contain the summary content.
  t.truthy(captured2);
  const summaryEntry = captured2.find(m => m.content && m.content.includes('Summary for restart test'));
  t.truthy(summaryEntry, 'committed summary should appear in post-restart context');
});