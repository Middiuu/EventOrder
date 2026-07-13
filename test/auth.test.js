const test = require("node:test");
const assert = require("node:assert/strict");
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
      for (const url of ["/", "/login.html", "/app.css", "/fonts.css", "/vendor/@fontsource/onest/400.css"]) {
        const res = await request({ url });
        assert.equal(res.status, 200, `atteso 200 per ${url}, ricevuto ${res.status}`);
      }
    });
  } finally {
    harness.cleanup();
  }
});

test("login: PIN errato rifiutato, PIN corretto imposta il cookie e sblocca le API", async () => {
  const harness = createHarness({ env: { APP_PIN: PIN } });

  try {
    await harness.withServer(async ({ request }) => {
      const wrong = await login(request, "9999");
      assert.equal(wrong.status, 401);

      const ok = await login(request, PIN);
      assert.equal(ok.status, 200);
      const setCookie = String(ok.headers["set-cookie"]);
      assert.match(setCookie, /pos_auth=/);
      assert.match(setCookie, /HttpOnly/);

      const withCookie = await request({
        url: "/api/products",
        headers: { Cookie: authCookie(ok) },
      });
      assert.equal(withCookie.status, 200);

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
