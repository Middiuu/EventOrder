const DAY_MS = 24 * 60 * 60 * 1000;

function sqliteTimestamp(timestampMs) {
  return new Date(timestampMs).toISOString().slice(0, 19).replace("T", " ");
}

function pruneServiceData(database, {
  auditRetentionDays,
  operationRetentionDays,
  nowMs = Date.now(),
}) {
  if (!auditRetentionDays && !operationRetentionDays) {
    return { auditEvents: 0, operationRequests: 0 };
  }

  const prune = database.transaction(() => {
    let auditEvents = 0;
    let operationRequests = 0;

    if (auditRetentionDays) {
      const cutoff = sqliteTimestamp(nowMs - auditRetentionDays * DAY_MS);
      auditEvents = database.prepare(
        "DELETE FROM audit_events WHERE occurred_at < ?"
      ).run(cutoff).changes;
    }

    if (operationRetentionDays) {
      const cutoff = sqliteTimestamp(nowMs - operationRetentionDays * DAY_MS);
      operationRequests = database.prepare(`
        DELETE FROM operation_requests
        WHERE created_at < ?
          AND session_id IN (
            SELECT id FROM cash_sessions WHERE closed_at IS NOT NULL
          )
      `).run(cutoff).changes;
    }

    return { auditEvents, operationRequests };
  });

  return prune();
}

module.exports = { pruneServiceData };
