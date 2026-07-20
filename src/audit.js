const { db } = require("./db");
const { log, errorFields } = require("./observability");

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function eventType(req) {
  const route = req.originalUrl.split("?")[0].replace(/^\/api\/+/, "").replace(/\/+/g, "/");
  return `${req.method.toLowerCase()}:${route}`.slice(0, 160);
}

function auditMiddleware(req, res, next) {
  if (!MUTATING_METHODS.has(req.method) || !req.path.startsWith("/api/")) return next();
  res.once("finish", () => {
    try {
      const status = res.statusCode;
      const outcome = status >= 500 ? "error" : status >= 400 ? "rejected" : "success";
      db.prepare(`
        INSERT INTO audit_events (event_type, outcome, status_code, request_id)
        VALUES (?, ?, ?, ?)
      `).run(eventType(req), outcome, status, req.requestId || null);
    } catch (error) {
      log("error", "audit_write_failed", {
        request_id: req.requestId,
        ...errorFields(error),
      });
    }
  });
  next();
}

module.exports = { auditMiddleware };
