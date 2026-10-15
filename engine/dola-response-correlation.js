/**
 * Task-scoped Dola response correlation helpers.
 * This module deliberately does not infer acceptance from response wording.
 */
function normalizeResponseText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function createResponseTracker({ taskId, workerRunId, baselineTexts = [] }) {
  const baseline = new Set(Array.from(baselineTexts, normalizeResponseText).filter(Boolean));
  const seen = new Set();

  function capture(candidate = {}) {
    const text = normalizeResponseText(candidate.text);
    if (!text || baseline.has(text) || seen.has(text)) return null;
    seen.add(text);
    return {
      taskId: String(taskId || ''),
      workerRunId: String(workerRunId || ''),
      conversationId: candidate.conversationId || null,
      messageId: candidate.messageId || null,
      source: String(candidate.source || 'unknown'),
      text: String(candidate.text),
      receivedAt: candidate.receivedAt || new Date().toISOString(),
      correlation: candidate.messageId
        ? 'message-identified'
        : candidate.conversationId
          ? 'conversation-context-only'
          : 'new-observation-only',
      isFinal: Boolean(candidate.isFinal)
    };
  }

  return { capture };
}

module.exports = { normalizeResponseText, createResponseTracker };
