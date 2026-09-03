import test from 'node:test';
import assert from 'node:assert/strict';
import { formatContinuationHandoff, selectContinuationEvidence } from './handoff.mjs';

function item(runId, command, status, evidence = 'CURRENT', cause = null) {
  return { runId, command, status, evidence, cause, classification: cause ? 'runtime-error' : null };
}

test('continuation evidence keeps only the newest observation for repeated commands', () => {
  const selected = selectContinuationEvidence([
    item('new-pass', 'npm test', 'PASS'),
    item('inspect', 'git log -1 --oneline', 'PASS'),
    item('old-fail', 'npm   test', 'FAIL', 'CURRENT', 'fixture failure'),
  ]);
  assert.deepEqual(selected.map((entry) => entry.runId), ['new-pass', 'inspect']);
});

test('state-centric handoff includes current repository delta and unresolved evidence without replaying every run', () => {
  const value = {
    project: { id: 'fixture/project', root: 'C:/repo', branch: 'main' },
    currency: { head: 'a'.repeat(40), worktreeFingerprint: 'sha256:fixture', dirty: true, changedFiles: [' M src/a.js', '?? src/b.js'] },
    workingState: {
      objective: { value: 'Fix search capability handling', evidence: 'CURRENT' },
      frontier: null,
    },
    lastMeaningfulRun: item('inspect', 'git log -1 --oneline', 'PASS'),
    recentEvidence: [
      item('inspect', 'git log -1 --oneline', 'PASS'),
      item('test-fail', 'npm test', 'FAIL', 'CURRENT', '1 test failed'),
      item('test-older', 'npm test', 'FAIL', 'CURRENT', '2 tests failed'),
    ],
  };
  const git = {
    branch: 'main', head: 'a'.repeat(40), upstream: 'origin/main', ahead: 1, behind: 0, dirty: true,
    changedFiles: [' M src/a.js', '?? src/b.js'],
  };

  const handoff = formatContinuationHandoff(value, git);
  assert.match(handoff, /REPO fixture\/project/);
  assert.match(handoff, /UPSTREAM origin\/main ahead=1 behind=0/);
  assert.match(handoff, /CHANGED\n M src\/a\.js\n\?\? src\/b\.js/);
  assert.match(handoff, /OBJECTIVE\nFix search capability handling · CURRENT/);
  assert.match(handoff, /OPEN_RESULT\nFAIL npm test\nruntime-error: 1 test failed\nrun:test-fail evidence=CURRENT/);
  assert.doesNotMatch(handoff, /test-older/);
});

test('newer success for the same command subsumes its older failure in the handoff', () => {
  const value = {
    project: { id: 'fixture/project', root: '/repo', branch: 'main' },
    currency: { head: 'b'.repeat(40), worktreeFingerprint: 'sha256:fixture', dirty: false, changedFiles: [] },
    workingState: { objective: null, frontier: null },
    lastMeaningfulRun: item('test-pass', 'npm test', 'PASS'),
    recentEvidence: [
      item('test-pass', 'npm test', 'PASS'),
      item('test-fail', 'npm test', 'FAIL', 'CURRENT', 'old failure'),
    ],
  };
  const git = { branch: 'main', head: 'b'.repeat(40), upstream: 'origin/main', ahead: 0, behind: 0, dirty: false, changedFiles: [] };
  const handoff = formatContinuationHandoff(value, git);
  assert.doesNotMatch(handoff, /OPEN_RESULT/);
  assert.doesNotMatch(handoff, /old failure/);
  assert.match(handoff, /RECENT_EVIDENCE\nPASS npm test · run:test-pass · CURRENT/);
});
