import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  page.on("response", async (response) => {
    if (response.request().method() === "PATCH" && !response.ok()) {
      console.error(`Memo update failed: ${response.status()} ${await response.text()}`);
    }
  });
});

test("concurrent API saves keep exactly one body and reject the other revision", async ({ page }) => {
  const { notebooks } = await (await page.request.get("/api/v1/notebooks")).json();
  const created = await page.request.post("/api/v1/memos", { data: {
    notebookId: notebooks[0].id, contentMarkdown: "同時保存の初期本文", tags: ["未整理"],
  } });
  expect(created.ok()).toBe(true);
  const { memo } = await created.json();
  const sessions = await Promise.all([0, 1].map(async () => {
    const response = await page.request.post(`/api/v1/memos/${memo.id}/edit-sessions`, { data: {} });
    expect(response.ok()).toBe(true);
    return (await response.json()).editSession;
  }));
  const bodies = ["同時保存の本文A", "同時保存の本文B"];
  const responses = await Promise.all(sessions.map((session, index) => page.request.patch(`/api/v1/memos/${memo.id}`, {
    data: { expectedRevision: session.baseRevision, expectedContentHash: session.baseContentHash,
      editSessionId: session.id, contentMarkdown: bodies[index], tags: [bodies[index]] },
  })));
  expect(responses.map((response) => response.status()).sort()).toEqual([200, 409]);
  const winner = responses.findIndex((response) => response.ok());
  const { memo: stored } = await (await page.request.get(`/api/v1/memos/${memo.id}`)).json();
  expect(stored.contentText).toBe(bodies[winner]);
  expect(stored.tags).toEqual([bodies[winner], "未整理"]);
  expect(stored.revision).toBe(memo.revision + 1);
  await page.goto(`/memo/${memo.id}`);
  await expect(page.getByRole("textbox", { name: "メモ本文" })).toHaveValue(bodies[winner]);
});

test("creation retries reuse one ID and a changed payload cannot reuse its key", async ({ page }) => {
  const { notebooks } = await (await page.request.get("/api/v1/notebooks")).json();
  const requestKey = crypto.randomUUID();
  const data = { requestKey, notebookId: notebooks[0].id, contentMarkdown: "重複防止の検査" };
  const responses = await Promise.all([1, 2, 3].map(() => page.request.post("/api/v1/memos", { data })));
  expect(responses.every((response) => response.ok())).toBe(true);
  const memos = await Promise.all(responses.map(async (response) => (await response.json()).memo));
  expect(new Set(memos.map((memo) => memo.id)).size).toBe(1);
  const conflicting = await page.request.post("/api/v1/memos", { data: { ...data, contentMarkdown: "別の本文" } });
  expect(conflicting.status()).toBe(409);
});

test("tag management, explicit organization and Japanese AND search work together", async ({ page }) => {
  const suffix = crypto.randomUUID().slice(0, 8); const tagA = `授業${suffix}`; const tagB = `質問例${suffix}`;
  await page.goto("/memo/tags");
  for (const name of [tagA, tagB]) {
    await page.getByRole("textbox", { name: "新しいタグ名" }).fill(name);
    await page.getByRole("button", { name: "タグ作成" }).click();
    await expect(page.getByRole("textbox", { name: `${name}のタグ名` })).toBeVisible();
  }
  const registry = (await (await page.request.get("/api/v1/tags")).json()).tags;
  const tagId = registry.find((tag: any) => tag.name === tagA).id;
  await page.goto("/memo"); await page.getByRole("button", { name: "新しいメモ" }).click();
  const body = page.getByRole("textbox", { name: "メモ本文" });
  await body.fill(`授業で得た気づき${suffix}`);
  await expect(page.getByRole("status")).toHaveText("サーバーに保存済み");
  const memoId = new URL(page.url()).pathname.split("/").at(-1)!;
  await page.getByRole("button", { name: "タグ変更" }).click();
  for (const name of [tagA, tagB]) { const button = page.getByRole("dialog").getByRole("button", { name, exact: true }); await button.click(); await expect(button).toHaveAttribute("aria-pressed", "true"); await expect(button).toBeEnabled(); }
  await page.goBack();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(body).toBeVisible();
  expect((await (await page.request.get(`/api/v1/memos/${memoId}`)).json()).memo.tags).toContain("未整理");
  await page.getByRole("button", { name: "整理完了", exact: true }).click();
  await expect(page.getByRole("button", { name: "未整理に戻す" })).toBeEnabled();
  const renamed = `考察${suffix}`;
  expect((await page.request.patch(`/api/v1/tags/${encodeURIComponent(tagA)}`, { data: { name: renamed } })).ok()).toBe(true);
  const registryAfter = (await (await page.request.get("/api/v1/tags")).json()).tags;
  expect(registryAfter.find((tag: any) => tag.name === renamed).id).toBe(tagId);
  expect((await page.request.delete(`/api/v1/tags/${encodeURIComponent("未整理")}`)).status()).toBe(409);
  await page.goto(`/memo?q=${encodeURIComponent("気づき" + suffix)}&tags=${encodeURIComponent(renamed)}&tags=${encodeURIComponent(tagB)}`);
  await expect(page.locator(`a[href="/memo/${memoId}"]`)).toBeVisible();
  await page.getByRole("textbox", { name: "メモ検索" }).fill(renamed);
  await page.getByRole("button", { name: "検索", exact: true }).click();
  await expect(page.locator(`a[href="/memo/${memoId}"]`)).toHaveCount(0);
});

test("image references survive body edits, trash and restore", async ({ page }) => {
  await page.goto("/memo"); await page.getByRole("button", { name: "新しいメモ" }).click();
  const body = page.getByRole("textbox", { name: "メモ本文" });
  await body.fill("画像を持つメモ"); await expect(page.getByRole("status")).toHaveText("サーバーに保存済み");
  const memoId = new URL(page.url()).pathname.split("/").at(-1)!;
  await page.getByLabel("添付画像", { exact: true }).setInputFiles({ name: "pixel.png", mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=", "base64") });
  await expect(page.getByRole("region", { name: "添付画像一覧" }).locator("img")).toBeVisible();
  await expect(body).toBeEnabled(); await body.fill("画像を残して本文を編集");
  await expect(page.getByRole("status")).toHaveText("サーバーに保存済み");
  await page.reload(); await expect(body).toHaveValue("画像を残して本文を編集");
  const source = await page.getByRole("region", { name: "添付画像一覧" }).locator("img").getAttribute("src");
  expect((await page.request.get(source!)).ok()).toBe(true);
  await page.getByRole("button", { name: "ごみ箱へ", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "ごみ箱へ移動する" }).click();
  await expect(page).toHaveURL(/\/memo$/);
  await page.getByRole("link", { name: "ごみ箱", exact: true }).click();
  const article = page.getByRole("article").filter({ hasText: "画像を残して本文を編集" });
  await article.getByRole("button", { name: "復元", exact: true }).click(); await expect(article).toHaveCount(0);
  await page.goto(`/memo/${memoId}`); await expect(body).toHaveValue("画像を残して本文を編集");
  await expect(page.getByRole("region", { name: "添付画像一覧" }).locator("img")).toHaveAttribute("src", source!);
  expect((await page.request.get(source!)).ok()).toBe(true);
  await page.screenshot({ path: `test-results/personal-memo-image-${test.info().project.name}.png` });
});

test("one-character autosave, reload, browser back and a second client share the same memo", async ({ page, browser }) => {
  await page.goto("/memo");
  await page.getByRole("button", { name: "新しいメモ" }).click();
  const body = page.getByRole("textbox", { name: "メモ本文" });
  await expect(body).toBeEnabled();
  const url = page.url();
  await body.fill("あ");
  await expect(page.getByRole("status")).toHaveText("サーバーに保存済み");
  await page.reload();
  await expect(body).toHaveValue("あ");
  const literal = "あ\n\n# 見出しではない\n**そのまま** 😊\n";
  await body.fill(literal);
  await expect(page.getByRole("status")).toHaveText("サーバーに保存済み");
  await page.reload();
  await expect(body).toHaveValue(literal);

  const secondContext = await browser.newContext({ storageState: await page.context().storageState() });
  const second = await secondContext.newPage();
  try {
    await second.goto(url);
    await expect(second.getByRole("textbox", { name: "メモ本文" })).toHaveValue(literal);
    await page.goBack();
    await expect(page).toHaveURL(/\/memo$/);
    await page.getByRole("textbox", { name: "メモ検索" }).fill("あ");
    await page.getByRole("button", { name: "検索", exact: true }).click();
    await page.locator(`a[href="${new URL(url).pathname}"]`).click();
    await page.goBack();
    await expect(page).toHaveURL(/\/memo\?q=/);
    await expect(page.getByRole("textbox", { name: "メモ検索" })).toHaveValue("あ");
    await page.screenshot({ path: `test-results/personal-memo-list-${test.info().project.name}.png` });
  } finally { await secondContext.close(); }
});

test("an offline draft survives back and reload; a remote update never replaces it", async ({ page }) => {
  await page.goto("/memo");
  await page.getByRole("button", { name: "新しいメモ" }).click();
  const body = page.getByRole("textbox", { name: "メモ本文" });
  await expect(body).toBeEnabled();
  await body.fill("同期前");
  await expect(page.getByRole("status")).toHaveText("サーバーに保存済み");
  const url = page.url();
  const memoId = new URL(url).pathname.split("/").at(-1)!;
  await page.context().setOffline(true);
  await body.fill("未同期の下書き😊");
  await expect(page.getByRole("status")).toHaveText("端末に下書き保存済み・未同期");
  await page.goBack();
  await page.context().setOffline(false);
  const sessionResponse = await page.request.post(`/api/v1/memos/${memoId}/edit-sessions`, { data: {} });
  expect(sessionResponse.ok()).toBe(true);
  const { editSession } = await sessionResponse.json();
  const update = await page.request.patch(`/api/v1/memos/${memoId}`, { data: {
    expectedRevision: editSession.baseRevision, expectedContentHash: editSession.baseContentHash,
    editSessionId: editSession.id, contentMarkdown: "別の画面の更新",
  } });
  expect(update.ok()).toBe(true);
  await page.goto(url);
  await expect(body).toHaveValue("未同期の下書き😊");
  await expect(page.getByRole("status")).toHaveText("ほかの画面の更新と競合しています");
  await page.reload();
  await expect(body).toHaveValue("未同期の下書き😊");
  await page.getByRole("button", { name: "サーバーの本文を確認" }).click();
  await expect(page.locator("pre")).toHaveText("別の画面の更新");
  const nextSession = await page.request.post(`/api/v1/memos/${memoId}/edit-sessions`, { data: {} });
  const { editSession: binding } = await nextSession.json();
  const richUpdate = await page.request.patch(`/api/v1/memos/${memoId}`, { data: {
    expectedRevision: binding.baseRevision, expectedContentHash: binding.baseContentHash, editSessionId: binding.id,
    contentJson: { type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "書式のある更新" }] }] },
    contentMarkdown: "## 書式のある更新",
  } });
  expect(richUpdate.ok()).toBe(true);
  await page.reload();
  await expect(body).toHaveValue("未同期の下書き😊");
  await expect(page.getByRole("status")).toHaveText("ほかの画面の更新と競合しています");
  await page.screenshot({ path: `test-results/personal-memo-draft-${test.info().project.name}.png` });
});

test("the HTTP MCP endpoint reads and edits the same memo as the web screen", async ({ page }) => {
  const notebooksResponse = await page.request.get("/api/v1/notebooks");
  const { notebooks } = await notebooksResponse.json();
  const createdResponse = await page.request.post("/api/v1/memos", { data: {
    notebookId: notebooks[0].id, contentMarkdown: "画面入口", tags: ["未整理"],
  } });
  expect(createdResponse.ok()).toBe(true);
  const { memo: created } = await createdResponse.json();
  const credentialsResponse = await page.request.post("/api/v1/api-tokens", { data: {
    name: "supermemo-local-preflight", scopes: ["read:memos", "write:memos"],
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  } });
  expect(credentialsResponse.ok()).toBe(true);
  const credentials = await credentialsResponse.json();
  const call = async (name: string, arguments_: Record<string, unknown>) => {
    const response = await page.request.post("/mcp", {
      headers: { Authorization: `Bearer ${credentials.token}`, "MCP-Protocol-Version": "2025-11-25", Accept: "application/json, text/event-stream" },
      data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: arguments_ } },
    });
    expect(response.ok()).toBe(true);
    const reply = await response.json();
    expect(reply.error).toBeUndefined();
    return reply.result;
  };
  try {
    await page.goto(`/memo/${created.id}`);
    const body = page.getByRole("textbox", { name: "メモ本文" });
    await expect(body).toHaveValue("画面入口");
    const initial = await call("get_memo", { memoId: created.id });
    expect(initial.structuredContent.memo.id).toBe(created.id);
    expect(initial.structuredContent.memo.revision).toBe(created.revision);
    const changed = await call("update_memo", {
      memoId: created.id, expectedRevision: created.revision, contentMarkdown: "MCPからの更新",
    });
    expect(changed.isError).toBe(false);
    expect(changed.structuredContent.memo.id).toBe(created.id);
    await page.reload();
    await expect(body).toHaveValue("MCPからの更新");
    await body.fill("画面からの更新");
    await expect(page.getByRole("status")).toHaveText("サーバーに保存済み");
    const readBack = await call("get_memo", { memoId: created.id });
    expect(readBack.structuredContent.memo.contentText).toBe("画面からの更新");
    expect(readBack.structuredContent.memo.revision).toBeGreaterThan(changed.structuredContent.memo.revision);
    const stale = await call("update_memo", {
      memoId: created.id, expectedRevision: created.revision, contentMarkdown: "古い版で上書き",
    });
    expect(stale.isError).toBe(true);
    expect((await call("get_memo", { memoId: created.id })).structuredContent.memo.contentText).toBe("画面からの更新");
    const fromMcp = await call("create_memo", {
      notebookId: notebooks[0].id, contentMarkdown: "会話入口", tags: ["未整理"],
    });
    expect(fromMcp.isError).toBe(false);
    const mcpId = fromMcp.structuredContent.memo.id;
    await page.goto(`/memo/${mcpId}`);
    await expect(body).toHaveValue("会話入口");
  } finally {
    const revoked = await page.request.delete(`/api/v1/api-tokens/${credentials.apiToken.id}`);
    expect(revoked.ok()).toBe(true);
  }
});
