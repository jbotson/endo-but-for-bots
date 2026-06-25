// @ts-check

import '@endo/init/debug.js';

import test from 'ava';

import { resolveMacros } from '../src/macros.js';

test('expands {{char}}/{{user}}/{{persona}}/{{original}}', t => {
  const out = resolveMacros(
    'You are {{char}}. The user, {{user}}, is {{persona}}. Original: {{original}}',
    {
      characterName: 'Seraphina',
      userName: 'Alex',
      personaDescription: 'a traveler',
      original: 'Be nice.',
    },
  );
  t.is(
    out,
    'You are Seraphina. The user, Alex, is a traveler. Original: Be nice.',
  );
});

test('capitalized macros expand to capitalized names', t => {
  const out = resolveMacros('{{Char}} met {{User}}.', {
    characterName: 'seraphina',
    userName: 'alex',
  });
  t.is(out, 'Seraphina met Alex.');
});

test('collapses 3+ newlines to at most two', t => {
  const out = resolveMacros('a\n\n\n\nb', {
    characterName: 'x',
    userName: 'y',
  });
  t.is(out, 'a\n\nb');
});

test('unknown macros pass through verbatim', t => {
  const out = resolveMacros('{{random:a,b}} stays {{roll:d6}}', {
    characterName: 'x',
    userName: 'y',
  });
  t.is(out, '{{random:a,b}} stays {{roll:d6}}');
});

test('empty original substitutes empty string', t => {
  const out = resolveMacros('{{original}}.', {
    characterName: 'x',
    userName: 'y',
  });
  t.is(out, '.');
});