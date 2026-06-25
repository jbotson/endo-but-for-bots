// @ts-check
/* eslint-disable no-await-in-loop */

import '@endo/init/debug.js';

import test from 'ava';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { makeConversationTree } from '@endo/conversation-tree';

import { importCard, importChat } from '../src/import.js';
import { loadAgent, loadState, saveState, loadJson } from '../src/agent-state.js';
import { makeDiskBackend } from '../src/disk-backend.js';

const setupDir = async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tavern-import-'));
  const stateDir = path.join(dir, 'tavern', 'seraphina');
  return { dir, stateDir };
};

const v2Card = {
  spec: '2.0',
  data: {
    name: 'Seraphina',
    description: 'a guide',
    personality: 'calm',
    scenario: 'a library',
    first_mes: 'Hello, traveler.',
    mes_example: 'User: hi\nChar: hello',
    system_prompt: 'You are {{char}}. Answer as {{char}}. {{original}}',
    post_history_instructions: 'Stay in voice, {{char}}.',
    alternate_greetings: ['Greeting two'],
    extensions: { depth_prompt: { depth: 4, role: 'system', prompt: 'Remember {{user}}.' } },
  },
};

test('importCard writes agent.json + card.json and never touches tree.jsonl', async t => {
  const { dir, stateDir } = await setupDir();
  const cardPath = path.join(dir, 'seraphina.json');
  await fsp.writeFile(cardPath, JSON.stringify(v2Card), 'utf8');

  const res = await importCard({
    card: cardPath,
    agent: 'seraphina',
    stateDir,
    userName: 'Alex',
    personaDescription: 'a curious traveler',
  });

  const agent = await loadAgent(res.agentPath);
  t.is(agent.characterName, 'Seraphina');
  t.is(agent.userName, 'Alex');
  t.regex(agent.systemPrompt, /You are Seraphina\./);
  t.is(agent.postHistoryInstructions, 'Stay in voice, Seraphina.');
  t.deepEqual(agent.depthPrompt, { depth: 4, role: 'system', prompt: 'Remember Alex.' });
  t.is(agent.provider.name, 'default');

  // card.json is verbatim raw
  const raw = await loadJson(path.join(stateDir, 'card.json'));
  t.is(raw.spec, '2.0');
  t.is(raw.data.name, 'Seraphina');

  // tree.jsonl MUST NOT exist yet (no-recreate invariant)
  t.false(fs.existsSync(path.join(stateDir, 'tree.jsonl')));
});

test('re-importing a card rewrites agent.json without changing tree.jsonl', async t => {
  const { dir, stateDir } = await setupDir();
  const cardPath = path.join(dir, 'seraphina.json');
  await fsp.writeFile(cardPath, JSON.stringify(v2Card), 'utf8');

  await importCard({ card: cardPath, agent: 'seraphina', stateDir });
  // Simulate existing history (write tree.jsonl by hand).
  await fsp.writeFile(
    path.join(stateDir, 'tree.jsonl'),
    `${JSON.stringify({ id: 'root', parentId: null, messages: [], metadata: {}, timestamp: 1 })}\n`,
    'utf8',
  );

  const patched = JSON.parse(JSON.stringify(v2Card));
  patched.data.system_prompt = 'You are {{char}}, the older wiser version.';
  await fsp.writeFile(cardPath, JSON.stringify(patched), 'utf8');
  const r2 = await importCard({ card: cardPath, agent: 'seraphina', stateDir });

  const agent = await loadAgent(r2.agentPath);
  t.regex(agent.systemPrompt, /older wiser version/);

  // tree.jsonl unchanged byte-for-byte
  const before = await fsp.readFile(
    path.join(stateDir, 'tree.jsonl'),
    'utf8',
  );
  t.regex(before, /"id":"root"/);
});

test('importChat builds a linear disk tree from a .jsonl chat export', async t => {
  const { dir, stateDir } = await setupDir();
  const cardPath = path.join(dir, 'seraphina.json');
  const chatPath = path.join(dir, 'chat.jsonl');
  await fsp.writeFile(cardPath, JSON.stringify(v2Card), 'utf8');
  const header = { user_name: 'Alex', character_name: 'Seraphina', chat_metadata: {} };
  const lines = [
    JSON.stringify(header),
    JSON.stringify({ name: 'Seraphina', is_user: false, is_system: false, mes: 'Hello, traveler.', send_date: '1' }),
    JSON.stringify({ name: 'Alex', is_user: true, is_system: false, mes: 'Hi there.', send_date: '2' }),
    JSON.stringify({ name: 'Seraphina', is_user: false, is_system: false, mes: 'How can I help?', send_date: '3' }),
  ];
  await fsp.writeFile(chatPath, lines.join('\n'), 'utf8');

  // Import card first so agent.json exists, then chat.
  const cardResult = await importCard({ card: cardPath, agent: 'seraphina', stateDir });
  const chatResult = await importChat({
    chat: chatPath,
    agent: 'seraphina',
    stateDir,
    systemPromptRoot: cardResult.systemPrompt,
  });

  t.is(chatResult.messageCount, 3);

  // Reload the tree from disk and verify the chain.
  const backend = await makeDiskBackend(path.join(stateDir, 'tree.jsonl'));
  const tree = makeConversationTree(backend);
  const roots = await tree.getRoots();
  t.is(roots.length, 1);
  t.is(roots[0].messages[0].role, 'system');
  // Walk children of root → linear chain of length 3.
  let cursor = roots[0].id;
  const collected = [];
  for (let i = 0; i < 3; i += 1) {
    const kids = await tree.getChildren(cursor);
    t.is(kids.length, 1, `expected exactly one child at depth ${i + 1}`);
    cursor = kids[0].id;
    collected.push(kids[0].messages[0].role);
  }
  t.deepEqual(collected, ['assistant', 'user', 'assistant']);
});

test('importChat refuses to overwrite an existing tree.jsonl without --replace', async t => {
  const { dir, stateDir } = await setupDir();
  const chatPath = path.join(dir, 'chat.jsonl');
  await fsp.writeFile(
    chatPath,
    [JSON.stringify({ user_name: 'Alex', character_name: 'S' }), JSON.stringify({ is_user: true, mes: 'hi' })].join('\n'),
    'utf8',
  );
  // pre-existing tree
  await fsp.mkdir(stateDir, { recursive: true });
  await fsp.writeFile(
    path.join(stateDir, 'tree.jsonl'),
    `${JSON.stringify({ id: 'root', parentId: null, messages: [], metadata: {}, timestamp: 1 })}\n`,
    'utf8',
  );

  const res = await importChat({ chat: chatPath, agent: 'seraphina', stateDir });
  t.is(res.messageCount, 0);
  // tree unchanged
  const after = await fsp.readFile(path.join(stateDir, 'tree.jsonl'), 'utf8');
  t.true(after.includes('"id":"root"'));
});

test('state.json load/save round-trips lastProcessedMessageNumber', async t => {
  const sPath = path.join(os.tmpdir(), `tavern-state-${Math.random().toString(36).slice(2)}.json`);
  const fresh = await loadState(sPath);
  t.is(fresh.lastProcessedMessageNumber, 0);
  await saveState(sPath, { lastProcessedMessageNumber: 7 });
  const loaded = await loadState(sPath);
  t.is(loaded.lastProcessedMessageNumber, 7);
  await fsp.rm(sPath, { force: true });
});