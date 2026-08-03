'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOrder, agentPacket, cleanIntent } = require('../src/core');

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
