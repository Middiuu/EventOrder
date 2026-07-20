const crypto = require("crypto");
const { config } = require("./config");
const { db } = require("./db");

const COOKIE_NAME = "pos_auth";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 1024;

// Percorsi sempre accessibili anche senza login (per mostrare la pagina di accesso).
// La welcome ("/"), il login e gli asset base restano accessibili senza PIN.
const PUBLIC_PATHS = new Set([
  "/", "/index.html", "/api/config", "/api/health", "/api/auth/login", "/login.html",
  "/app.css", "/fonts.css", "/theme-init.js", "/welcome.js", "/login.js",
]);

// Gli asset statici di /vendor (font, librerie) servono anche a welcome e login.
function isPublicPath(reqPath) {
  return PUBLIC_PATHS.has(reqPath) || reqPath.startsWith("/vendor/");
}

function tokenDigest(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function pruneSessions(now = Date.now()) {
  db.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(now);
}

function createSession(now = Date.now()) {
  pruneSessions(now);
  const count = db.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get().count;
  if (count >= MAX_SESSIONS) {
    db.prepare(`
      DELETE FROM auth_sessions WHERE token_digest IN (
        SELECT token_digest FROM auth_sessions ORDER BY expires_at ASC LIMIT ?
      )
    `).run(count - MAX_SESSIONS + 1);
  }
  const token = crypto.randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO auth_sessions (token_digest, expires_at) VALUES (?, ?)")
    .run(tokenDigest(token), now + SESSION_TTL_MS);
  return token;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    try {
      out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      // Un cookie malformato equivale a un cookie non valido, non a un errore server.
      return {};
    }
  }
  return out;
}

function isAuthenticated(req) {
  if (!config.APP_PIN) return true;
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  const now = Date.now();
  pruneSessions(now);
  const digest = tokenDigest(token);
  const session = db.prepare("SELECT expires_at FROM auth_sessions WHERE token_digest = ?").get(digest);
  if (!session || session.expires_at <= now) {
    db.prepare("DELETE FROM auth_sessions WHERE token_digest = ?").run(digest);
    return false;
  }
  return true;
}

// Middleware: attivo solo se APP_PIN e' impostato.
function authMiddleware(req, res, next) {
  if (!config.APP_PIN) return next();
  if (isPublicPath(req.path) || isAuthenticated(req)) return next();

  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Autenticazione richiesta" });
  }
  return res.redirect("/login.html");
}

// Anti brute-force sul PIN: dopo MAX_ATTEMPTS tentativi falliti dallo stesso
// indirizzo il login resta bloccato per LOCK_MS dall'ultimo tentativo fallito.
const MAX_ATTEMPTS = 5;
const LOCK_MS = 5 * 60 * 1000;
function loginBlockedMs(ip, now) {
  // pulizia pigra: le voci scadute azzerano anche il contatore
  db.prepare("DELETE FROM login_attempts WHERE last_fail_at < ?").run(now - LOCK_MS);
  const entry = db.prepare(`
    SELECT attempt_count, last_fail_at FROM login_attempts WHERE client_key = ?
  `).get(ip);
  if (!entry || entry.attempt_count < MAX_ATTEMPTS) return 0;
  return LOCK_MS - (now - entry.last_fail_at);
}

function sessionCookie(token, maxAgeSeconds, secure) {
  const attributes = [
    `${COOKIE_NAME}=${token}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

// Handler di login: verifica il PIN e crea una sessione casuale, non derivata
// dal PIN. Il server conserva solo l'hash del token e puo' quindi revocarlo.
function loginHandler(req, res) {
  if (!config.APP_PIN) return res.json({ ok: true });

  const ip = req.ip || req.socket?.remoteAddress || "sconosciuto";
  const now = Date.now();
  const blockedMs = loginBlockedMs(ip, now);
  if (blockedMs > 0) {
    const min = Math.ceil(blockedMs / 60000);
    return res.status(429).json({ error: `Troppi tentativi: riprova tra ${min} minut${min === 1 ? "o" : "i"}` });
  }

  const pin = String(req.body?.pin || "");
  const a = Buffer.from(pin);
  const b = Buffer.from(config.APP_PIN);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) {
    db.prepare(`
      INSERT INTO login_attempts (client_key, attempt_count, last_fail_at)
      VALUES (?, 1, ?)
      ON CONFLICT(client_key) DO UPDATE SET
        attempt_count = attempt_count + 1,
        last_fail_at = excluded.last_fail_at
    `).run(ip.slice(0, 160), now);
    return res.status(401).json({ error: "PIN errato" });
  }

  db.prepare("DELETE FROM login_attempts WHERE client_key = ?").run(ip);
  const token = createSession(now);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Set-Cookie", sessionCookie(token, SESSION_TTL_MS / 1000, req.secure));
  res.json({ ok: true });
}

function logoutHandler(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
    db.prepare("DELETE FROM auth_sessions WHERE token_digest = ?").run(tokenDigest(token));
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Set-Cookie", sessionCookie("", 0, req.secure));
  res.json({ ok: true });
}

function clearAuthenticationState() {
  db.exec("DELETE FROM auth_sessions; DELETE FROM login_attempts;");
}

module.exports = {
  authMiddleware,
  isAuthenticated,
  loginHandler,
  logoutHandler,
  clearAuthenticationState,
};
