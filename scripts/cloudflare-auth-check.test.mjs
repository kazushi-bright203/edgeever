import { expect, test } from "bun:test";
import { isCloudflareAuthenticated } from "./cloudflare-auth-check.mjs";
test("Wrangler exit zero without a logged-in account is not authentication", () => {
  expect(isCloudflareAuthenticated({ status: 0, stdout: "You are not authenticated. Please run wrangler login." })).toBe(false);
  expect(isCloudflareAuthenticated({ status: 0, stdout: "You are logged in with an OAuth Token, associated with this account." })).toBe(true);
  expect(isCloudflareAuthenticated({ status: 1, stdout: "You are logged in" })).toBe(false);
  expect(isCloudflareAuthenticated({ status: 0, stdout: "Getting User settings..." })).toBe(false);
});
