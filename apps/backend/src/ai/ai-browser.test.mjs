import http from "node:http";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { db, close, base } from "../../test/integration-client.mjs";
import { token, fixtureUserId, prepareMockFixture, clearMockFixtureConfiguration } from "./ai-fixture-utils.mjs";
await prepareMockFixture();
const require = createRequire(new URL("../../package.json", import.meta.url));
const { chromium } = require("playwright");
const server = http.createServer(async (req, res) => {
  const parts = [];
  for await (const part of req) parts.push(part);
  const body = parts.length ? JSON.parse(Buffer.concat(parts).toString()) : {};
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/models") return res.end(JSON.stringify({ data: [{ id: "ui-fixture-model" }] }));
  if (req.url === "/chat/completions") {
    const prompt = body.messages.at(-1).content;
    const content = prompt.startsWith("Generate ONLY validator.cpp")
      ? "#include <iostream>\nint main(){long long a,b;if(!(std::cin>>a>>b))return 1;std::cin>>std::ws;return !std::cin.eof()||a < -1000000000LL||a > 1000000000LL||b < -1000000000LL||b > 1000000000LL;}"
      : "OK";
    return res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }] }));
  }
  if (req.url === "/mcp") {
    if (body.method === "notifications/initialized") {
      res.statusCode = 202;
      return res.end();
    }
    const result =
      body.method === "initialize"
        ? { protocolVersion: "2025-03-26" }
        : body.method === "tools/list"
        ? { tools: [{ name: "tavily-search", inputSchema: { properties: { query: {} } } }] }
        : { content: [{ type: "text", text: "UI mock search result" }] };
    return res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  }
  res.statusCode = 404;
  res.end("{}");
});
await new Promise(resolve => server.listen(2230, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await context.addInitScript(
    token => localStorage.setItem("appState", JSON.stringify({ token, localLocale: "en_US" })),
    token
  );
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(`${base}/ai/configuration`, { waitUntil: "networkidle" });
  const field = label =>
    page.locator(".field").filter({ has: page.locator("label", { hasText: new RegExp("^" + label + "$") }) });
  await field("Base URL").locator("input").fill("http://127.0.0.1:2230");
  await page.locator("input[type=password]").fill("isolated-ui-secret");
  await page.getByRole("button", { name: "Fetch models", exact: true }).click();
  await page.getByText("Fetched 1 models.", { exact: true }).waitFor();
  assert.equal(await page.locator("input[type=password]").inputValue(), "");
  await field("Model").locator("div.dropdown").click();
  await field("Model").locator(".menu .item").filter({ hasText: "ui-fixture-model" }).click();
  await page.getByRole("button", { name: "Save and test connection", exact: true }).click();
  await page.locator(".positive.message").filter({ hasText: "Connected in" }).waitFor();
  await page.getByText("Search / MCP", { exact: true }).click();
  await field("Search API").locator("div.dropdown").click();
  await page.getByText("MCP (Streamable HTTP)", { exact: true }).click();
  await field("Base URL").locator("input").fill("http://127.0.0.1:2230/mcp");
  await page.locator("input[type=password]").fill("isolated-ui-search-secret");
  await page.getByRole("button", { name: "Save and test connection", exact: true }).click();
  await page.locator(".positive.message").filter({ hasText: "Connected in" }).waitFor();
  assert.equal(await page.locator("input[type=password]").inputValue(), "");
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await page.locator("input[type=password]").inputValue(), "");
  assert(!(await page.locator("body").innerText()).includes("isolated-ui-secret"));
  await page.goto(`${base}/ai/import`, { waitUntil: "networkidle" });
  await page.locator('input[type=file][accept*=".markdown"]').setInputFiles({
    name: "fixture.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Fixture\n\nCompute $a+b$.")
  });
  await page.waitForFunction(() => document.querySelector("textarea")?.value.includes("Compute"));
  assert((await page.locator("textarea").inputValue()).includes("$a+b$"));
  await page.locator("input[type=number]").fill("4");
  assert(await page.getByRole("button", { name: "Import and run all", exact: true }).isDisabled());
  await page.locator("input[type=number]").fill("5");
  assert(await page.getByRole("button", { name: "Import and run all", exact: true }).isEnabled());
  if (process.env.HYHOJ_TEST_EVIDENCE_DIR) {
    fs.mkdirSync(process.env.HYHOJ_TEST_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.HYHOJ_TEST_EVIDENCE_DIR, "ai-import.png"), fullPage: true });
  }
  const fixtureProblems = await db.query(
    "SELECT problemId FROM ai_job WHERE ownerId=? AND status='completed' AND problemId IS NOT NULL ORDER BY updatedAt DESC LIMIT 1",
    [fixtureUserId]
  );
  assert(fixtureProblems.length, "Run the isolated AI integration fixture first");
  await page.goto(`${base}/p/id/${fixtureProblems[0].problemId}/files`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "AI assistance", exact: true }).waitFor();
  await page.getByLabel("Run an AI step", { exact: true }).click();
  assert(
    await page
      .locator(".menu.visible .item")
      .filter({ hasText: /^Test data$/ })
      .isEnabled()
  );
  if (process.env.HYHOJ_TEST_EVIDENCE_DIR)
    await page.screenshot({ path: path.join(process.env.HYHOJ_TEST_EVIDENCE_DIR, "ai-data.png"), fullPage: true });
  assert.equal(errors.length, 0, errors.join(";"));
  console.log(
    "PASS AI browser: key input/save/redaction, model discovery/select, LLM test, MCP test, Markdown upload, count bounds, data panel, no JS errors"
  );
  await context.close();
} finally {
  await clearMockFixtureConfiguration();
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  await close();
}
