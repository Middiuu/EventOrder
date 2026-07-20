const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const path = require("path");
const { spawnSync } = require("child_process");
const { createHarness } = require("./helpers/app-test-utils");

const PIN = "1234";

function login(request, pin) {
  return request({
    method: "POST",
    url: "/api/auth/login",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin }),
  });
}

function authCookie(loginRes) {
  return String(loginRes.headers["set-cookie"] || "").split(";")[0];
}

test("senza APP_PIN l'accesso e' libero e /api/config lo dichiara", async () => {
  const harness = createHarness();

  try {
    await harness.withServer(async ({ request }) => {
      const cfg = (await request({ url: "/api/config" })).json();
      assert.equal(cfg.authRequired, false);

      const products = await request({ url: "/api/products" });
      assert.equal(products.status, 200);
      assert.match(products.headers["content-security-policy"], /script-src 'self'/);
      assert.match(products.headers["content-security-policy"], /script-src-attr 'none'/);
      assert.match(products.headers["content-security-policy"], /object-src 'none'/);

      // il login resta un no-op
      const res = await login(request, "qualsiasi");
      assert.equal(res.status, 200);
    });
  } finally {
    harness.cleanup();
  }
});

test("con APP_PIN: API protette, pagine reindirizzate, asset pubblici accessibili", async () => {
  const harness = createHarness({ env: { APP_PIN: PIN } });

  try {
    await harness.withServer(async ({ request }) => {
      const cfg = (await request({ url: "/api/config" })).json();
      assert.equal(cfg.authRequired, true);

      // API senza cookie -> 401
      const api = await request({ url: "/api/products" });
      assert.equal(api.status, 401);

      // pagina protetta -> redirect alla pagina di accesso
      const page = await request({ url: "/cassa.html" });
      assert.equal(page.status, 302);
      assert.equal(page.headers.location, "/login.html");

      // welcome, login e asset base restano raggiungibili
      for (const url of [
        "/", "/login.html", "/app.css", "/fonts.css", "/theme-init.js",
        "/welcome.js", "/login.js", "/vendor/@fontsource/onest/400.css",
      ]) {
        const res = await request({ url });
        assert.equal(res.status, 200, `atteso 200 per ${url}, ricevuto ${res.status}`);
      }
    });
  } finally {
    harness.cleanup();
  }
});

test("login: PIN errato rifiutato, PIN corretto imposta il cookie e sblocca le API", async () => {
  const harness = createHarness({ env: { APP_PIN: PIN, OPERATORS: "Anna,Luca" } });

  try {
    await harness.withServer(async ({ request }) => {
      const wrong = await login(request, "9999");
      assert.equal(wrong.status, 401);

      const ok = await login(request, PIN);
      assert.equal(ok.status, 200);
      const setCookie = String(ok.headers["set-cookie"]);
      assert.match(setCookie, /pos_auth=/);
      assert.match(setCookie, /HttpOnly/);
      assert.match(setCookie, /SameSite=Strict/);
      assert.equal(ok.headers["cache-control"], "no-store");

      const token = authCookie(ok).split("=")[1];
      const legacyToken = crypto.createHmac("sha256", PIN).update("pos-auth-v1").digest("hex");
      assert.match(token, /^[A-Za-z0-9_-]{43}$/);
      assert.notEqual(token, legacyToken);

      // Ogni login crea una credenziale distinta e non derivata dal PIN.
      const secondLogin = await login(request, PIN);
      assert.notEqual(authCookie(secondLogin), authCookie(ok));

      const withCookie = await request({
        url: "/api/products",
        headers: { Cookie: authCookie(ok) },
      });
      assert.equal(withCookie.status, 200);

      const publicCfg = (await request({ url: "/api/config" })).json();
      assert.deepEqual(publicCfg.operators, []);
      const authenticatedCfg = (await request({
        url: "/api/config",
        headers: { Cookie: authCookie(ok) },
      })).json();
      assert.deepEqual(authenticatedCfg.operators, ["Anna", "Luca"]);

      // un cookie contraffatto non basta
      const forged = await request({
        url: "/api/products",
        headers: { Cookie: "pos_auth=token-inventato" },
      });
      assert.equal(forged.status, 401);
    });
  } finally {
    harness.cleanup();
  }
});

test("logout revoca la sessione e cancella il cookie", async () => {
  const harness = createHarness({ env: { APP_PIN: PIN } });

  try {
    await harness.withServer(async ({ request }) => {
      const loggedIn = await login(request, PIN);
      const cookie = authCookie(loggedIn);

      const logout = await request({
        method: "POST",
        url: "/api/auth/logout",
        headers: { Cookie: cookie },
      });
      assert.equal(logout.status, 200);
      assert.match(String(logout.headers["set-cookie"]), /pos_auth=;/);
      assert.match(String(logout.headers["set-cookie"]), /Max-Age=0/);

      const afterLogout = await request({
        url: "/api/products",
        headers: { Cookie: cookie },
      });
      assert.equal(afterLogout.status, 401);
    });
  } finally {
    harness.cleanup();
  }
});

test("le sessioni scadono anche lato server", async () => {
  const harness = createHarness({ env: { APP_PIN: PIN } });
  const realNow = Date.now;

  try {
    await harness.withServer(async ({ request }) => {
      const loggedIn = await login(request, PIN);
      const cookie = authCookie(loggedIn);
      const issuedAt = realNow();
      Date.now = () => issuedAt + 24 * 60 * 60 * 1000 + 1;

      const expired = await request({
        url: "/api/products",
        headers: { Cookie: cookie },
      });
      assert.equal(expired.status, 401);
    });
  } finally {
    Date.now = realNow;
    harness.cleanup();
  }
});

test("HOST non locale richiede APP_PIN, host consentiti e origin pubblico all'avvio", () => {
  const projectRoot = path.join(__dirname, "..");
  const configPath = path.join(projectRoot, "src", "config.js");
  const run = (host, pin, extra = {}) => spawnSync(process.execPath, ["-e", `require(${JSON.stringify(configPath)})`], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOST: host,
      APP_PIN: pin,
      ALLOWED_HOSTS: "",
      PUBLIC_ORIGIN: "",
      TRUST_PROXY: "",
      ...extra,
    },
    encoding: "utf8",
  });

  const exposed = run("0.0.0.0", "");
  assert.notEqual(exposed.status, 0);
  assert.match(exposed.stderr, /APP_PIN e' obbligatorio/);

  const weakPin = run("0.0.0.0", "12");
  assert.notEqual(weakPin.status, 0);
  assert.match(weakPin.stderr, /almeno 4 cifre/);

  const missingHosts = run("0.0.0.0", PIN);
  assert.notEqual(missingHosts.status, 0);
  assert.match(missingHosts.stderr, /ALLOWED_HOSTS e' obbligatorio/);

  const missingOrigin = run("0.0.0.0", PIN, { ALLOWED_HOSTS: "192.168.1.20" });
  assert.notEqual(missingOrigin.status, 0);
  assert.match(missingOrigin.stderr, /PUBLIC_ORIGIN e' obbligatorio/);

  assert.equal(run("0.0.0.0", PIN, {
    ALLOWED_HOSTS: "192.168.1.20,pos.example.test",
    PUBLIC_ORIGIN: "http://192.168.1.20:3000",
  }).status, 0);
  assert.equal(run("127.0.0.1", "").status, 0);
});

test("il cookie e' Secure solo quando HTTPS e' attestato da un proxy attendibile", async () => {
  const plainHarness = createHarness({ env: { APP_PIN: PIN } });
  try {
    await plainHarness.withServer(async ({ request }) => {
      const plain = await request({
        method: "POST",
        url: "/api/auth/login",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-Proto": "https",
        },
        body: JSON.stringify({ pin: PIN }),
      });
      assert.equal(plain.status, 200);
      assert.doesNotMatch(String(plain.headers["set-cookie"]), /; Secure(?:;|$)/);
    });
  } finally {
    plainHarness.cleanup();
  }

  const proxyHarness = createHarness({ env: { APP_PIN: PIN, TRUST_PROXY: "loopback" } });
  try {
    await proxyHarness.withServer(async ({ request }) => {
      const proxied = await request({
        method: "POST",
        url: "/api/auth/login",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-Proto": "https",
        },
        body: JSON.stringify({ pin: PIN }),
      });
      assert.equal(proxied.status, 200);
      assert.match(String(proxied.headers["set-cookie"]), /; Secure(?:;|$)/);
    });
  } finally {
    proxyHarness.cleanup();
  }
});

test("X-Forwarded-For non aggira il rate limit senza un proxy attendibile", async () => {
  const harness = createHarness({ env: { APP_PIN: PIN } });
  try {
    await harness.withServer(async ({ request }) => {
      for (let i = 0; i < 5; i++) {
        const wrong = await request({
          method: "POST",
          url: "/api/auth/login",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": `203.0.113.${i + 1}`,
          },
          body: JSON.stringify({ pin: "0000" }),
        });
        assert.equal(wrong.status, 401);
      }

      const blocked = await request({
        method: "POST",
        url: "/api/auth/login",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": "198.51.100.50",
        },
        body: JSON.stringify({ pin: PIN }),
      });
      assert.equal(blocked.status, 429);
    });
  } finally {
    harness.cleanup();
  }
});

test("un proxy loopback attendibile separa il rate limit per IP client", async () => {
  const harness = createHarness({ env: { APP_PIN: PIN, TRUST_PROXY: "loopback" } });
  try {
    await harness.withServer(async ({ request }) => {
      for (let i = 0; i < 5; i++) {
        const wrong = await request({
          method: "POST",
          url: "/api/auth/login",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": "203.0.113.10",
          },
          body: JSON.stringify({ pin: "0000" }),
        });
        assert.equal(wrong.status, 401);
      }

      const otherClient = await request({
        method: "POST",
        url: "/api/auth/login",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": "198.51.100.20",
        },
        body: JSON.stringify({ pin: PIN }),
      });
      assert.equal(otherClient.status, 200);
    });
  } finally {
    harness.cleanup();
  }
});

test("rate limiting: dopo 5 PIN errati il login e' bloccato anche col PIN giusto", async () => {
  const harness = createHarness({ env: { APP_PIN: PIN } });

  try {
    await harness.withServer(async ({ request }) => {
      for (let i = 0; i < 5; i++) {
        const res = await login(request, "0000");
        assert.equal(res.status, 401, `tentativo ${i + 1} atteso 401`);
      }

      const blocked = await login(request, PIN);
      assert.equal(blocked.status, 429);
      assert.match(blocked.json().error, /Troppi tentativi/);

      // il blocco copre anche i tentativi errati successivi
      const stillBlocked = await login(request, "0000");
      assert.equal(stillBlocked.status, 429);
    });
  } finally {
    harness.cleanup();
  }
});

test("il login corretto azzera il contatore dei tentativi falliti", async () => {
  const harness = createHarness({ env: { APP_PIN: PIN } });

  try {
    await harness.withServer(async ({ request }) => {
      for (let i = 0; i < 4; i++) {
        await login(request, "0000");
      }

      // sotto la soglia: il PIN giusto passa e resetta il contatore
      const ok = await login(request, PIN);
      assert.equal(ok.status, 200);

      // dopo il reset c'e' di nuovo margine per sbagliare
      const wrongAgain = await login(request, "0000");
      assert.equal(wrongAgain.status, 401);
    });
  } finally {
    harness.cleanup();
  }
});

test("un cookie percent-encoded malformato viene rifiutato con 401", async () => {
  const harness = createHarness({ env: { APP_PIN: PIN } });

  try {
    await harness.withServer(async ({ request }) => {
      const res = await request({
        url: "/api/products",
        headers: { Cookie: "pos_auth=%E0%A4%A" },
      });
      assert.equal(res.status, 401);
    });
  } finally {
    harness.cleanup();
  }
});

test("sessioni e rate limit restano nel database invece che nella memoria del processo", async () => {
  const harness = createHarness({ env: { APP_PIN: PIN } });

  try {
    await harness.withServer(async ({ request }) => {
      const loggedIn = await login(request, PIN);
      const cookie = authCookie(loggedIn);
      const dbModule = require("../src/db");
      assert.equal(dbModule.db.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get().count, 1);

      const authPath = require.resolve("../src/auth");
      delete require.cache[authPath];
      const reloadedAuth = require("../src/auth");
      assert.equal(reloadedAuth.isAuthenticated({ headers: { cookie } }), true);

      await login(request, "0000");
      const attempt = dbModule.db.prepare(`
        SELECT attempt_count FROM login_attempts LIMIT 1
      `).get();
      assert.equal(attempt.attempt_count, 1);

      reloadedAuth.clearAuthenticationState();
      assert.equal(reloadedAuth.isAuthenticated({ headers: { cookie } }), false);
      assert.equal(dbModule.db.prepare("SELECT COUNT(*) AS count FROM login_attempts").get().count, 0);
    });
  } finally {
    harness.cleanup();
  }
});
