const crypto = require("crypto");
const { config } = require("./config");

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,120}$/;

function requestIdMiddleware(req, res, next) {
  const supplied = String(req.get("X-Request-ID") || "");
  req.requestId = SAFE_REQUEST_ID.test(supplied) ? supplied : crypto.randomUUID();
  res.setHeader("X-Request-ID", req.requestId);

  if (config.LOG_REQUESTS) {
    const startedAt = process.hrtime.bigint();
    res.once("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      log("info", "http_request", {
        request_id: req.requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: Math.round(durationMs * 10) / 10,
      });
    });
  }
  next();
}

function log(level, event, fields = {}) {
  const record = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...fields,
  });
  if (level === "error") console.error(record);
  else console.log(record);
}

function errorFields(error) {
  return {
    error_name: error?.name || "Error",
    error_message: error?.message || String(error),
  };
}

module.exports = { requestIdMiddleware, log, errorFields };
