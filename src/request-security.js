const { config } = require("./config");

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const RESTORE_CONTENT_TYPES = new Set([
  "application/octet-stream",
  "application/x-sqlite3",
  "application/vnd.sqlite3",
]);

function normalizeHostname(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

function requestHost(req) {
  const raw = String(req.headers.host || "").trim();
  if (!raw) return null;
  try {
    const parsed = new URL(`http://${raw}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      return null;
    }
    return {
      raw,
      hostname: normalizeHostname(parsed.hostname),
    };
  } catch {
    return null;
  }
}

function normalizeOrigin(value) {
  try {
    const parsed = new URL(String(value || ""));
    if (!["http:", "https:"].includes(parsed.protocol)
        || parsed.username || parsed.password
        || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function expectedOrigin(req, host) {
  if (config.PUBLIC_ORIGIN) return config.PUBLIC_ORIGIN;
  const protocol = req.protocol === "https" ? "https" : "http";
  return normalizeOrigin(`${protocol}://${host.raw}`);
}

function hasRequestBody(req) {
  if (req.headers["transfer-encoding"]) return true;
  const length = req.headers["content-length"];
  return length !== undefined && String(length).trim() !== "0";
}

function isJsonContentType(contentType) {
  return contentType === "application/json"
    || /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(contentType);
}

function reject(req, res, status, message) {
  res.setHeader("Cache-Control", "no-store");
  if (req.path.startsWith("/api/")) return res.status(status).json({ error: message });
  return res.status(status).type("text/plain").send(message);
}

function requestSecurityMiddleware(req, res, next) {
  const host = requestHost(req);
  if (!host || !config.ALLOWED_HOSTS.includes(host.hostname)) {
    return reject(req, res, 421, "Host della richiesta non consentito");
  }

  if (!req.path.startsWith("/api/") || !MUTATING_METHODS.has(req.method)) return next();

  const fetchSite = String(req.get("Sec-Fetch-Site") || "").trim().toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return reject(req, res, 403, "Origine della richiesta non consentita");
  }

  const originHeader = req.get("Origin");
  if (originHeader) {
    const origin = normalizeOrigin(originHeader);
    if (!origin || origin !== expectedOrigin(req, host)) {
      return reject(req, res, 403, "Origine della richiesta non consentita");
    }
  }

  const contentType = String(req.get("Content-Type") || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType || hasRequestBody(req)) {
    const allowed = req.path === "/api/reports/restore"
      ? RESTORE_CONTENT_TYPES.has(contentType)
      : isJsonContentType(contentType);
    if (!allowed) return reject(req, res, 415, "Content-Type non supportato");
  }

  next();
}

module.exports = { requestSecurityMiddleware };
