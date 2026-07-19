const crypto = require("crypto");
const { config } = require("./config");

const COOKIE_NAME = "pos_auth";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 1024;
const sessions = new Map(); // sha256(token) -> scadenza assoluta

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
  for (const [digest, expiresAt] of sessions) {
    if (expiresAt <= now) sessions.delete(digest);
  }
}

function createSession(now = Date.now()) {
  pruneSessions(now);
  while (sessions.size >= MAX_SESSIONS) {
    sessions.delete(sessions.keys().next().value);
  }
  const token = crypto.randomBytes(32).toString("base64url");
  sessions.set(tokenDigest(token), now + SESSION_TTL_MS);
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
  const expiresAt = sessions.get(digest);
  if (!expiresAt || expiresAt <= now) {
    sessions.delete(digest);
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
const loginAttempts = new Map(); // ip -> { count, lastFailAt }

function loginBlockedMs(ip, now) {
  // pulizia pigra: le voci scadute azzerano anche il contatore
  for (const [key, entry] of loginAttempts) {
    if (now - entry.lastFailAt > LOCK_MS) loginAttempts.delete(key);
  }
  const entry = loginAttempts.get(ip);
  if (!entry || entry.count < MAX_ATTEMPTS) return 0;
  return LOCK_MS - (now - entry.lastFailAt);
}

function sessionCookie(token, maxAgeSeconds) {
  return `${COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
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
    const entry = loginAttempts.get(ip);
    loginAttempts.set(ip, { count: (entry?.count || 0) + 1, lastFailAt: now });
    return res.status(401).json({ error: "PIN errato" });
  }

  loginAttempts.delete(ip);
  const token = createSession(now);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Set-Cookie", sessionCookie(token, SESSION_TTL_MS / 1000));
  res.json({ ok: true });
}

function logoutHandler(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
    sessions.delete(tokenDigest(token));
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Set-Cookie", sessionCookie("", 0));
  res.json({ ok: true });
}

module.exports = { authMiddleware, isAuthenticated, loginHandler, logoutHandler };
