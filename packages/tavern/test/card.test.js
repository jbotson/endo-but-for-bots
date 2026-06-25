// @ts-check

import '@endo/init/debug.js';

import test from 'ava';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { parseCardFile } from '../src/card.js';

const tmp = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tavern-card-'));
  return dir;
};

const writeFile = async (dir, name, contents) => {
  const p = path.join(dir, name);
  await fs.writeFile(p, contents, 'utf8');
  return p;
};

test('parses a V2 .json card (data-veiled shape)', async t => {
  const dir = await tmp();
  const v2 = {
    spec: '2.0',
    data: {
      name: 'Seraphina',
      description: 'a calm guide',
      personality: 'gentle',
      scenario: 'a quiet library',
      first_mes: 'Hello, traveler.',
      system_prompt: '',
      post_history_instructions: '',
      extensions: { depth_prompt: { depth: 4, role: 'system', prompt: '' } },
    },
  };
  const p = await writeFile(dir, 'seraphina.json', JSON.stringify(v2));
  const card = await parseCardFile(p);
  t.is(card.specVersion, 'v2');
  t.is(card.data.name, 'Seraphina');
  t.is(card.name, 'Seraphina');
  t.is(card.format, 'json');
  t.is(card.cardPath, p);
  t.is(card.raw.spec, '2.0');
});

test('promotes a V1 .json card into the V2 data shape', async t => {
  const dir = await tmp();
  const v1 = {
    name: 'Bob',
    description: 'a bard',
    personality: 'loud',
    scenario: 'a tavern',
    first_mes: 'Welcome!',
    mes_example: 'Example dialogue',
    custom_unknown: 'preserved',
  };
  const p = await writeFile(dir, 'bob.json', JSON.stringify(v1));
  const card = await parseCardFile(p);
  t.is(card.specVersion, 'v1');
  t.is(card.data.name, 'Bob');
  t.is(card.data.first_mes, 'Welcome!');
  t.is(card.data.mes_example, 'Example dialogue');
  // raw is verbatim V1 (never destroys unknown fields)
  t.is(card.raw.custom_unknown, 'preserved');
});

test('V2 promotion keeps unknown V1 fields in raw, not in data', async t => {
  const dir = await tmp();
  const v1 = { name: 'Q', description: 'd', extra_field: 'x' };
  const p = await writeFile(dir, 'q.json', JSON.stringify(v1));
  const card = await parseCardFile(p);
  t.true('extra_field' in card.raw);
  t.false('extra_field' in card.data);
});

test('rejects an unsupported extension', async t => {
  const dir = await tmp();
  const p = await writeFile(dir, 'x.txt', 'nope');
  await t.throwsAsync(() => parseCardFile(p), {
    message: /Unsupported card extension/,
  });
});