const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./test/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: 30_000,
  use: {
    headless: true,
    locale: "it-IT",
    timezoneId: "Europe/Rome",
    trace: "retain-on-failure",
  },
});
