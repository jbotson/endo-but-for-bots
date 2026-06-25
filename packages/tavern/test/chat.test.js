// @ts-check

import '@endo/init/debug.js';

import test from 'ava';

import { parseChat } from '../src/chat.js';

const headerLine = JSON.stringify({
  user_name: 'Alex',
  character_name: 'Seraphina',
  chat_metadata: { note: 'x' },
});
const userMsg = m => JSON.stringify({ name: 'Alex', is_user: true, is_system: false, mes: m, send_date: '1' });
const charMsg = m => JSON.stringify({ name: 'Seraphina', is_user: false, is_system: false, mes: m, send_date: '2' });
const sysMsg = m => JSON.stringify({ name: 'system', is_user: false, is_system: true, mes: m, send_date: '3' });

test('parses header + user/assistant messages, skipping system by default', t => {
  const { header, messages } = parseChat(
    [headerLine, userMsg('hi'), charMsg('hello'), sysMsg('[system note]')].join('\n'),
  );
  t.is(header.user_name, 'Alex');
  t.is(header.character_name, 'Seraphina');
  t.is(messages.length, 2);
  t.is(messages[0].role, 'user');
  t.is(messages[0].content, 'hi');
  t.is(messages[1].role, 'assistant');
  t.is(messages[1].content, 'hello');
});

test('keepSystem: true includes is_system lines as role:system', t => {
  const { messages } = parseChat(
    [headerLine, sysMsg('[note]'), userMsg('hi')].join('\n'),
    { keepSystem: true },
  );
  t.is(messages.length, 2);
  t.is(messages[0].role, 'system');
  t.is(messages[0].content, '[note]');
});

test('uses swipe_id to pick the active swipe', t => {
  const entry = JSON.stringify({
    name: 'Seraphina',
    is_user: false,
    is_system: false,
    mes: 'first',
    swipe_id: 1,
    swipes: ['first', 'second', 'third'],
  });
  const { messages } = parseChat([headerLine, entry].join('\n'));
  t.is(messages[0].content, 'second');
});

test('clamps swipe_id to the available range', t => {
  const entry = JSON.stringify({
    name: 'S',
    is_user: false,
    is_system: false,
    mes: 'x',
    swipe_id: 99,
    swipes: ['a', 'b'],
  });
  const { messages } = parseChat([headerLine, entry].join('\n'));
  t.is(messages[0].content, 'b');
});

test('handles a headerless file (line 1 is itself a message)', t => {
  const { messages } = parseChat(userMsg('hello world'));
  t.is(messages.length, 1);
  t.is(messages[0].role, 'user');
  t.is(messages[0].content, 'hello world');
});

test('empty input yields empty result', t => {
  const { header, messages } = parseChat('');
  t.deepEqual(header, {});
  t.is(messages.length, 0);
});