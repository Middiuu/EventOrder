const crypto = require("crypto");

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,120}$/;

function requestIdFrom(req) {
  const raw = req.get("Idempotency-Key");
  if (!raw) return null;
  const value = String(raw).trim();
  return IDEMPOTENCY_KEY_RE.test(value) ? value : null;
}

function fingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function operationRequest(database, operation, requestId) {
  return database.prepare(`
    SELECT operation, request_id, request_fingerprint, session_id, response_json
    FROM operation_requests
    WHERE operation = ? AND request_id = ?
  `).get(operation, requestId);
}

function parseStoredResponse(row) {
  try {
    return JSON.parse(row.response_json);
  } catch {
    throw new Error(`Risultato idempotente non leggibile per ${row.operation}`);
  }
}

function storeOperationRequest(database, {
  operation,
  requestId,
  requestFingerprint,
  sessionId,
  response,
}) {
  database.prepare(`
    INSERT INTO operation_requests
      (operation, request_id, request_fingerprint, session_id, response_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(operation, requestId, requestFingerprint, sessionId, JSON.stringify(response));
}

module.exports = {
  IDEMPOTENCY_KEY_RE,
  fingerprint,
  operationRequest,
  parseStoredResponse,
  requestIdFrom,
  storeOperationRequest,
};
