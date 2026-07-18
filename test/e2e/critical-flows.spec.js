/* global document */
const { test, expect } = require("@playwright/test");
const fs = require("fs");
const { createHarness } = require("../helpers/app-test-utils");

async function openSession(request) {
  const response = await request({
    method: "POST",
    url: "/api/sessions/open",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ opening_float_cents: 2_000, operator: "E2E" }),
  });
  expect(response.status).toBe(200);
}

test("una risposta persa e il reload non duplicano l'incasso", async ({ page }) => {
  const harness = createHarness();
  try {
    await harness.withServer(async ({ baseUrl, request }) => {
      await openSession(request);
      await page.goto(`${baseUrl}/cassa.html`);
      await page.waitForLoadState("networkidle");

      await page.locator("#productsGrid .product-card").first().click();
      await page.locator("#printBtn").click();
      await page.locator('[data-method="card"]').click();

      let intercepted = false;
      await page.route("**/api/sales/print", async route => {
        if (intercepted) return route.continue();
        intercepted = true;
        await route.fetch();
        await route.abort("failed");
      });
      await page.locator("#confirmPayBtn").click();
      await expect.poll(() => intercepted).toBe(true);
      await expect(page.locator("#paymentModal")).toBeVisible();

      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(page.locator("#cart .cart-item")).toHaveCount(1);
      await expect(page.locator("#payTotal")).not.toHaveText("€ 0,00");
      await expect(page.locator('[data-method="card"]')).toBeDisabled();
      await expect(page.locator("#confirmPayBtn")).toBeEnabled();

      await page.unroute("**/api/sales/print");
      await page.locator("#printBtn").click();
      await expect(page.locator("#paymentModal")).toBeVisible();
      await page.locator("#confirmPayBtn").click();
      await expect(page.locator("#cart .cart-item")).toHaveCount(0);

      const sales = await request({ url: "/api/sales?limit=10" });
      expect(sales.status).toBe(200);
      expect(sales.json()).toHaveLength(1);
    });
  } finally {
    harness.cleanup();
  }
});

test("Back con una modale aperta ripristina inert e scroll della SPA", async ({ page }) => {
  const harness = createHarness();
  try {
    await harness.withServer(async ({ baseUrl }) => {
      await page.goto(`${baseUrl}/cassa.html`);
      await page.waitForLoadState("networkidle");
      await page.getByRole("link", { name: "Prodotti" }).click();
      await expect(page).toHaveURL(/\/products\.html$/);
      await page.locator("#productsTable [data-edit]").first().click();
      await expect(page.locator("#editProductModal")).toBeVisible();

      await page.goBack();
      await expect(page).toHaveURL(/\/cassa\.html$/);
      await expect(page.getByRole("heading", { name: "Vendita al banco" })).toBeVisible();

      const state = await page.evaluate(() => ({
        overflow: document.body.style.overflow,
        inertConnected: [...document.querySelectorAll("[inert]")].filter(node => node.isConnected).length,
        visibleDialogs: [...document.querySelectorAll('[role="dialog"]')]
          .filter(node => !node.closest("[hidden]")).length,
      }));
      expect(state).toEqual({ overflow: "", inertConnected: 0, visibleDialogs: 0 });
    });
  } finally {
    harness.cleanup();
  }
});

test("una navigazione lenta non puo' sovrascrivere quella piu' recente", async ({ page }) => {
  const harness = createHarness();
  try {
    await harness.withServer(async ({ baseUrl }) => {
      await page.goto(`${baseUrl}/cassa.html`);
      await page.waitForLoadState("networkidle");
      await page.route("**/products.html", async route => {
        await new Promise(resolve => setTimeout(resolve, 350));
        await route.continue();
      });

      await page.getByRole("link", { name: "Prodotti" }).click();
      await page.getByRole("link", { name: "Vendite" }).click();
      await expect(page).toHaveURL(/\/sales\.html$/);
      await expect(page.getByRole("heading", { name: /Storico vendite/i })).toBeVisible();
      await page.waitForTimeout(500);
      await expect(page).toHaveURL(/\/sales\.html$/);
    });
  } finally {
    harness.cleanup();
  }
});

test("lo storico carica progressivamente le pagine successive", async ({ page }) => {
  const harness = createHarness();
  try {
    await harness.withServer(async ({ baseUrl }) => {
      const sale = id => ({
        id,
        sale_number: id,
        created_at: "2026-07-18 12:00:00",
        total_cents: 500,
        payment_method: "cash",
        voided: 0,
        can_void: false,
        can_reprint: false,
        print_status: "printed",
        items: [{ qty: 1, name: `Prodotto ${id}`, options: [], note: "" }],
      });
      await page.route("**/api/sales?**", async route => {
        const cursor = new URL(route.request().url()).searchParams.get("cursor");
        const body = cursor
          ? { sales: [sale(1)], next_cursor: null }
          : { sales: Array.from({ length: 100 }, (_, index) => sale(101 - index)), next_cursor: 2 };
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
      });

      await page.goto(`${baseUrl}/sales.html`);
      await expect(page.locator("#salesList .sale-row")).toHaveCount(100);
      await expect(page.locator("#loadMoreSalesBtn")).toBeVisible();
      await page.locator("#loadMoreSalesBtn").click();
      await expect(page.locator("#salesList .sale-row")).toHaveCount(101);
      await expect(page.locator("#loadMoreSalesBtn")).toBeHidden();
    });
  } finally {
    harness.cleanup();
  }
});

test("la UI crea il backup con POST e lo scarica in streaming", async ({ page }) => {
  const harness = createHarness();
  try {
    await harness.withServer(async ({ baseUrl }) => {
      await page.goto(`${baseUrl}/reports.html`);
      await page.waitForLoadState("networkidle");
      await page.locator('[data-report-view="data"]').click();

      const downloadPromise = page.waitForEvent("download");
      await page.locator("#createBackupBtn").click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toMatch(/eventorder-backup-\d{8}-\d{6}/);
      const downloadedPath = await download.path();
      expect(fs.statSync(downloadedPath).size).toBeGreaterThan(0);
    });
  } finally {
    harness.cleanup();
  }
});
