const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createHarness } = require("./helpers/app-test-utils");

function rawRequest(baseUrl, { method = "GET", url = "/", headers = {}, body } = {}) {
  const target = new URL(url, baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(target, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: res.statusCode,
          text,
          json: () => JSON.parse(text || "{}"),
        });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("le mutazioni cross-site vengono respinte anche senza APP_PIN", async () => {
  const harness = createHarness();

  try {
    await harness.withServer(async ({ request }) => {
      const product = (await request({ url: "/api/products" })).json()[0];
      await request({
        method: "POST",
        url: "/api/sessions/open",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opening_float_cents: 0, operator: "Test" }),
      });
      const sale = await request({
        method: "POST",
        url: "/api/sales/print",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [{ product_id: product.id, qty: 1 }],
          payment_method: "cash",
          cash_received_cents: product.price_cents,
        }),
      });
      assert.equal(sale.status, 200);

      const attack = await request({
        method: "POST",
        url: "/api/sales/void-last",
        headers: {
          Origin: "https://attacker.example",
          "Sec-Fetch-Site": "cross-site",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "confirm=yes",
      });
      assert.equal(attack.status, 403);

      const [stored] = (await request({ url: "/api/sales?limit=1" })).json();
      assert.equal(stored.voided, 0);
    });
  } finally {
    harness.cleanup();
  }
});

test("una mutazione same-origin resta consentita", async () => {
  const harness = createHarness();

  try {
    await harness.withServer(async ({ baseUrl, request }) => {
      const response = await request({
        method: "POST",
        url: "/api/sessions/open",
        headers: {
          Origin: baseUrl,
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ opening_float_cents: 0, operator: "Test" }),
      });
      assert.equal(response.status, 200);
    });
  } finally {
    harness.cleanup();
  }
});

test("host non autorizzati e content type semplici vengono respinti", async () => {
  const harness = createHarness();

  try {
    await harness.withServer(async ({ baseUrl, request }) => {
      const badHost = await rawRequest(baseUrl, {
        url: "/api/config",
        headers: { Host: "attacker.example" },
      });
      assert.equal(badHost.status, 421);

      const badContentType = await request({
        method: "POST",
        url: "/api/sessions/open",
        headers: {
          Origin: baseUrl,
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "opening_float_cents=0&operator=Test",
      });
      assert.equal(badContentType.status, 415);

      const current = await request({ url: "/api/sessions/current" });
      assert.equal(current.json().session, null);
    });
  } finally {
    harness.cleanup();
  }
});

test("un form vuoto resta bloccato anche senza header browser", async () => {
  const harness = createHarness();

  try {
    await harness.withServer(async ({ request }) => {
      const response = await request({
        method: "POST",
        url: "/api/sales/void-last",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      assert.equal(response.status, 415);
    });
  } finally {
    harness.cleanup();
  }
});

test("PUBLIC_ORIGIN e ALLOWED_HOSTS governano gli accessi pubblicati", async () => {
  const harness = createHarness({
    env: {
      ALLOWED_HOSTS: "pos.example.test",
      PUBLIC_ORIGIN: "https://pos.example.test",
      TRUST_PROXY: "loopback",
    },
  });

  try {
    await harness.withServer(async ({ baseUrl }) => {
      const accepted = await rawRequest(baseUrl, {
        method: "POST",
        url: "/api/sessions/open",
        headers: {
          Host: "pos.example.test",
          Origin: "https://pos.example.test",
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ opening_float_cents: 0, operator: "Test" }),
      });
      assert.equal(accepted.status, 200);

      const wrongOrigin = await rawRequest(baseUrl, {
        method: "POST",
        url: "/api/sessions/close",
        headers: {
          Host: "pos.example.test",
          Origin: "https://other.example.test",
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ counted_cash_cents: 0 }),
      });
      assert.equal(wrongOrigin.status, 403);
    });
  } finally {
    harness.cleanup();
  }
});
