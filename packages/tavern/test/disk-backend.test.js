// @ts-check

import '@endo/init/debug.js';

import test from 'ava';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { makeConversationTree } from '@endo/conversation-tree';

import { makeDiskBackend } from '../src/disk-backend.js';

const treePath = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tavern-disk-'));
  return path.join(dir, 'tree.jsonl');
};

const mkNode = (id, parentId, messages = [{ role: 'user', content: id }]) => harden({
  id,
  parentId,
  messages,
  metadata: {},
  timestamp: Date.now(),
});

test('fresh file: no roots, no nodes', async t => {
  const p = await treePath();
  const backend = await makeDiskBackend(p);
  t.deepEqual(await backend.getRoots(), []);
  t.is(await backend.getNode('missing'), null);
});

test('putNode appends + serves getNode from memory', async t => {
  const p = await treePath();
  const backend = await makeDiskBackend(p);
  await backend.putNode(mkNode('a', null));
  const got = await backend.getNode('a');
  t.truthy(got);
  t.is(got.id, 'a');
  const roots = await backend.getRoots();
  t.is(roots.length, 1);
  t.is(roots[0].id, 'a');
});

test('getChildren returns only nodes matching parentId', async t => {
  const p = await treePath();
  const backend = await makeDiskBackend(p);
  await backend.putNode(mkNode('a', null, [{ role: 'system', content: 'sys' }]));
  await backend.putNode(mkNode('b', 'a'));
  await backend.putNode(mkNode('c', 'a'));
  await backend.putNode(mkNode('d', 'b'));
  t.is((await backend.getChildren('a')).length, 2);
  t.is((await backend.getChildren(null)).length, 1);
  t.is((await backend.getChildren('b')).length, 1);
  t.is((await backend.getChildren('zzz')).length, 0);
});

test('persistence: a fresh backend reads a previously-written file', async t => {
  const p = await treePath();
  const b1 = await makeDiskBackend(p);
  await b1.putNode(mkNode('root', null));
  await b1.putNode(mkNode('leaf', 'root'));
  const b2 = await makeDiskBackend(p);
  t.truthy(await b2.getNode('root'));
  t.truthy(await b2.getNode('leaf'));
  t.deepEqual(
    (await b2.getChildren('root')).map(n => n.id),
    ['leaf'],
  );
});

test('skips a trailing partial line on load without error', async t => {
  const p = await treePath();
  const b1 = await makeDiskBackend(p);
  await b1.putNode(mkNode('root', null));
  // Append a half-written line (no newline / invalid JSON).
  await fs.appendFile(p, '{"id":"broken","parent');
  const b2 = await makeDiskBackend(p);
  t.truthy(await b2.getNode('root'));
  t.is(await b2.getNode('broken'), null);
});

test('makeConversationTree + disk backend interoperate end-to-end', async t => {
  const p = await treePath();
  const backend = await makeDiskBackend(p);
  const tree = makeConversationTree(backend);
  const root = await tree.addNode(null, [{ role: 'system', content: 'sys' }]);
  const u = await tree.addNode(root.id, [{ role: 'user', content: 'hi' }], {
    messageId: 'm1',
  });
  const a = await tree.addNode(u.id, [{ role: 'assistant', content: 'hello' }]);
  const chain = await tree.getPath(a.id);
  t.is(chain.length, 3);
  t.is(chain[0].content, 'sys');
  t.is(chain[1].content, 'hi');
  t.is(chain[2].content, 'hello');
  // survives reload
  const b2 = await makeDiskBackend(p);
  const t2 = makeConversationTree(b2);
  t.is(await t2.getNode(a.id), null || (await t2.getNode(a.id)));
  t.truthy(await t2.getNode(a.id));
  const chain2 = await t2.getPath(a.id);
  t.is(chain2.length, 3);
});

test('prepend a leading newline when appending to an unterminated file', async t => {
  const p = await treePath();
  // Manually write a line WITHOUT a trailing newline (e.g. a hand-edited
  // or crashed import), then putNode a second node.
  await fs.writeFile(p, JSON.stringify(mkNode('root', null)), 'utf8');
  const b1 = await makeDiskBackend(p);
  await b1.putNode(mkNode('leaf', 'root'));

  // Reload: both nodes must survive on separate lines (no merged line).
  const b2 = await makeDiskBackend(p);
  t.truthy(await b2.getNode('root'));
  t.truthy(await b2.getNode('leaf'));
  t.is((await b2.getChildren('root')).length, 1);
});