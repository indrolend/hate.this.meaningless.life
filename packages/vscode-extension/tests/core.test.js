'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createOrder,
  agentPacket,
  cleanIntent,
  defaultCloneDestination,
  isForbiddenImplicitProject,
  sameOrigin,
  inspectProject
} = require('../src/core');

const project = { root: '/repo', branch: 'main', head: 'abc123', changes: [' M game.cpp'] };

test('normalizes intent without erasing structure', () => {
  assert.equal(cleanIntent(' fix this  \r\nthen test  '), 'fix this\nthen test');
});

test('creates a reproducible bounded order', () => {
  const order = createOrder('Fix controls', project, new Date('2026-08-03T12:00:00Z'));
  assert.match(order.id, /^order-20260803120000-/);
  assert.equal(order.authority.commit, 'abc123');
  assert.equal(order.status, 'ready');
});

test('agent packet retains authority and evidence', () => {
  const order = createOrder('Fix controls', project, new Date('2026-08-03T12:00:00Z'));
  const packet = agentPacket(order);
  assert.match(packet, /GOAL: Fix controls/);
  assert.match(packet, /commit: abc123/);
  assert.match(packet, /commands and exit codes/);
});

test('rejects empty goals', () => {
  assert.throws(() => createOrder('  ', project), /empty/);
});

test('clone destination is deterministic', () => {
  assert.equal(
    defaultCloneDestination('C:\\Users\\alice'),
    'C:\\Users\\alice\\Projects\\hate.this.meaningless.life'
  );
});

test('startup does not implicitly select profile roots', () => {
  const home = 'C:\\Users\\alice';
  assert.equal(isForbiddenImplicitProject(home, home), true);
  assert.equal(isForbiddenImplicitProject(`${home}\\Desktop`, home), true);
  assert.equal(isForbiddenImplicitProject(`${home}\\Downloads`, home), true);
  assert.equal(isForbiddenImplicitProject(`${home}\\Projects\\digital-breakdown-apk`, home), false);
});

test('origin mismatch is rejected', () => {
  assert.equal(sameOrigin('https://github.com/indrolend/hate.this.meaningless.life.git', 'git@github.com:indrolend/hate.this.meaningless.life.git'), true);
  assert.equal(sameOrigin('https://github.com/indrolend/hate.this.meaningless.life.git', 'https://github.com/indrolend/digital-breakdown-apk.git'), false);
});

test('missing project yields NO PROJECT', async () => {
  const missing = await inspectProject('');
  assert.equal(missing.state, 'NO PROJECT');
  assert.equal(missing.verified, false);
});
