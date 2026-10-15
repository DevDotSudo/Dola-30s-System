const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeResponseText, createResponseTracker } = require('./dola-response-correlation');

test('normalizes response whitespace', () => {
  assert.equal(normalizeResponseText('  Dola\\naccepted   the task '), 'Dola accepted the task');
});

test('ignores text that was present before the task began', () => {
  const tracker = createResponseTracker({ taskId: 't1', workerRunId: 'r1', baselineTexts: ['old response'] });
  assert.equal(tracker.capture({ text: 'old   response' }), null);
});

test('captures fresh text once and scopes it to the task run', () => {
  const tracker = createResponseTracker({ taskId: 't2', workerRunId: 'r2', baselineTexts: [] });
  const response = tracker.capture({ text: 'New Dola response', source: 'dom:observer' });
  assert.equal(response.taskId, 't2');
  assert.equal(response.workerRunId, 'r2');
  assert.equal(response.text, 'New Dola response');
  assert.equal(response.correlation, 'new-observation-only');
  assert.equal(tracker.capture({ text: 'New Dola response', source: 'dom:observer' }), null);
});

test('identifiers improve response correlation but do not imply acceptance', () => {
  const tracker = createResponseTracker({ taskId: 't3', workerRunId: 'r3' });
  const response = tracker.capture({ text: 'Please confirm', conversationId: 'c1', messageId: 'm1' });
  assert.equal(response.correlation, 'identified');
  assert.equal(response.text, 'Please confirm');
});
