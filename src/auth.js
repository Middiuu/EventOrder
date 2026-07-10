const crypto = require("crypto");
const { config } = require("./config");

const COOKIE_NAME = "pos_auth";

// Percorsi sempre accessibili anche senza login (per mostrare la pagina di accesso).
const PUBLIC_PATHS = new Set(["/api/config", "/api/auth/login", "/login.html", "/app.css"]);

function expectedToken() {
  return crypto.createHmac("sha256", config.APP_PIN).update("pos-auth-v1").digest("hex");
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function isAuthenticated(req) {
  if (!config.APP_PIN) return true;
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token) return false;
  // confronto a tempo costante
  const a = Buffer.from(token);
  const b = Buffer.from(expectedToken());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Middleware: attivo solo se APP_PIN e' impostato.
function authMiddleware(req, res, next) {
  if (!config.APP_PIN) return next();
  if (PUBLIC_PATHS.has(req.path) || isAuthenticated(req)) return next();

  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Autenticazione richiesta" });
  }
  return res.redirect("/login.html");
}

// Handler di login: verifica il PIN e imposta il cookie.
function loginHandler(req, res) {
  if (!config.APP_PIN) return res.json({ ok: true });
  const pin = String(req.body?.pin || "");
  const a = Buffer.from(pin);
  const b = Buffer.from(config.APP_PIN);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return res.status(401).json({ error: "PIN errato" });

  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${expectedToken()}; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400`
  );
  res.json({ ok: true });
}

module.exports = { authMiddleware, loginHandler };
