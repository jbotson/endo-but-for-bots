// @ts-check

import '@endo/init/debug.js';

import test from 'ava';

import { resolvePrompt } from '../src/prompt.js';

const card = data => ({ data });

const naming = { characterName: 'Seraphina', userName: 'Alex' };

test('assembles a system prompt from included fields when no card system_prompt', t => {
  const c = card({
    description: 'a guide',
    personality: 'calm',
    scenario: 'a library',
    mes_example: 'User: hi\nChar: hello',
  });
  const { systemPrompt } = resolvePrompt(c, naming, { useCardSystemPrompt: true });
  t.regex(systemPrompt, /\[Description\][\s\S]*a guide/);
  t.regex(systemPrompt, /\[Personality\][\s\S]*calm/);
  t.regex(systemPrompt, /\[Scenario\][\s\S]*a library/);
  t.regex(systemPrompt, /\[Example dialogue\][\s\S]*hello/);
});

test('uses the card system_prompt when present and expands {{char}}/{{user}}/{{original}}', t => {
  const c = card({
    system_prompt: '{{original}} Refer to the user as {{user}}.',
  });
  const { systemPrompt } = resolvePrompt(c, naming);
  t.regex(systemPrompt, /Respond in character/);
  t.regex(systemPrompt, /Refer to the user as Alex/);
});

test('include:false omits a field', t => {
  const c = card({ description: 'd', personality: 'p', scenario: 's', mes_example: 'e' });
  const { systemPrompt } = resolvePrompt(c, naming, {
    include: { personality: false, scenario: false, mes_example: false, description: true },
  });
  t.regex(systemPrompt, /\[Description\][\s\S]*d/);
  t.false(/\[Personality\]/.test(systemPrompt));
  t.false(/\[Scenario\]/.test(systemPrompt));
  t.false(/\[Example dialogue\]/.test(systemPrompt));
});

test('falls back to {{original}} resolved prompt when all sections empty', t => {
  const c = card({});
  const { systemPrompt } = resolvePrompt(c, naming);
  t.is(systemPrompt, 'You are Seraphina. Respond in character.');
});

test('resolves post_history_instructions when included and non-empty', t => {
  const c = card({ post_history_instructions: 'Stay in voice, {{char}}.' });
  const { postHistoryInstructions } = resolvePrompt(c, naming);
  t.is(postHistoryInstructions, 'Stay in voice, Seraphina.');
});

test('returns empty PHI when disabled or empty', t => {
  t.is(resolvePrompt(card({ post_history_instructions: 'x' }), naming, {
    include: { post_history_instructions: false },
  }).postHistoryInstructions, '');
  t.is(resolvePrompt(card({}), naming).postHistoryInstructions, '');
});

test('resolves depth_prompt from extensions with macro expansion', t => {
  const c = card({ extensions: { depth_prompt: { depth: 4, role: 'system', prompt: 'Remember {{user}}.' } } });
  const { depthPrompt } = resolvePrompt(c, naming);
  t.deepEqual(depthPrompt, { depth: 4, role: 'system', prompt: 'Remember Alex.' });
});

test('returns null depth_prompt when absent or disabled', t => {
  t.is(resolvePrompt(card({}), naming).depthPrompt, null);
  t.is(
    resolvePrompt(card({ extensions: { depth_prompt: { depth: 4, prompt: 'x' } } }), naming, {
      include: { depth_prompt: false },
    }).depthPrompt,
    null,
  );
});

test('first_mes included as Greeting context with alternate greeting index', t => {
  const c = card({ first_mes: 'default greeting', alternate_greetings: ['alt1', 'alt2'] });
  const r0 = resolvePrompt(c, naming, { include: { first_mes: true, description: false, personality: false, scenario: false, mes_example: false } });
  t.regex(r0.systemPrompt, /\[Greeting\][\s\S]*default greeting/);
  const r2 = resolvePrompt(c, naming, {
    include: { first_mes: true, description: false, personality: false, scenario: false, mes_example: false },
    alternateGreetingIndex: 2,
  });
  t.regex(r2.systemPrompt, /\[Greeting\][\s\S]*alt2/);
});