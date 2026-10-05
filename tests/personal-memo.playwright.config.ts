import { defineConfig } from "@playwright/test";
import { E2E_STORAGE_STATE_PATH } from "./e2e/global-setup";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "personal-memo.spec.ts",
  globalSetup: "./e2e/global-setup.ts",
  workers: 1,
  timeout: 45000,
  expect: { timeout: 15000 },
  use: {
    channel: "chrome",
    baseURL: "http://127.0.0.1:5173",
    storageState: E2E_STORAGE_STATE_PATH,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "pc", use: { viewport: { width: 1280, height: 800 } } },
    // A narrow Chromium viewport is a regression check, not iPhone acceptance.
    { name: "narrow", use: { viewport: { width: 390, height: 844 } } },
  ],
});
