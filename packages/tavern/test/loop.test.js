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
import { loadAgent, loadState } from '../src/agent-state.js';

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

const setupState = async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tavern-loop-'));
  const stateDir = path.join(dir, 'tavern', 'seraphina');
  const cardPath = path.join(dir, 'seraphina.json');
  await fsp.writeFile(cardPath, JSON.stringify(v2Card), 'utf8');
  await importCard({ card: cardPath, agent: 'seraphina', stateDir });
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