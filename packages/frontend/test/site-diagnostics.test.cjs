// Run with: node --test packages/frontend/test/site-diagnostics.test.cjs
// Audit 2026-11-07 RM-07 (redacted diagnostic bundle): Site management's Diagnostic bundle section, with the real
// section and site-management API module, and the backend replaced. IDs typed in are checked before anything is sent,
// the bundle is saved as a JSON file, missing IDs are reported, and the server's refusals are shown.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { componentHarness } = require("./helpers/component-harness.cjs");

// Values made in the page's own realm, compared as plain data
const plain = value => JSON.parse(JSON.stringify(value));

const bundle = extra => ({
  bundle: { bundleVersion: 1, generatedAt: "2026-11-20T15:04:05.123Z", requestId: "r", administratorId: 1 },
  deployment: {},
  excluded: ["source code"],
  ...extra
});

function section(answer) {
  const saved = [];
  const h = componentHarness("pages/site-management/DiagnosticsSection.tsx", {
    admin: true,
    api: (endpoint, body) => (endpoint === "site-management/diagnosticBundle" ? answer(body) : undefined),
    globals: { Blob },
    deps: { "@/utils/downloadFile": { saveBlob: (blob, filename) => saved.push({ blob, filename }) } }
  });
  const input = id => h.find("Form.Input", props => props.id === id);
  const type = async (id, value) => {
    input(id).props.onChange(null, { value });
    await h.settle();
  };
  const download = async () => {
    await h.find("Button").props.onClick();
    await h.settle();
  };
  const requests = () => h.calls.filter(call => call.name === "site-management/diagnosticBundle");
  const message = kind => h.all(node => node.type?.name === "Message" && node.props[kind])[0]?.props.content;
  return { h, saved, type, download, requests, message };
}

test("the bundle is downloaded with the IDs typed in, each once, and saved as a JSON file named for its time", async () => {
  const page = section(() => ({
    response: bundle({ selected: { missingSubmissionIds: [99], missingAiJobIds: [], submissions: [], aiJobs: [] } })
  }));
  await page.h.settle();
  await page.type("diagnostic-submission-ids", "12, 15\n12 99");
  await page.type("diagnostic-ai-job-ids", "1B4E28BA-2FA1-4D2B-883F-0016D3CCA427");
  await page.download();
  assert.deepEqual(plain(page.requests().map(call => call.body)), [
    { submissionIds: [12, 15, 99], aiJobIds: ["1b4e28ba-2fa1-4d2b-883f-0016d3cca427"] }
  ]);
  assert.equal(page.saved.length, 1);
  assert.equal(page.saved[0].filename, "llmoj-diagnostics-2026-11-20T15-04-05Z.json");
  assert.equal(page.saved[0].blob.type, "application/json");
  const saved = JSON.parse(await page.saved[0].blob.text());
  assert.equal(saved.bundle.bundleVersion, 1, "the bundle exactly as the server made it");
  assert.equal(page.message("positive"), ".diagnostics.downloaded .diagnostics.missing", "it says what wasn't found");
});

test("with no IDs, the bundle asks for none", async () => {
  const page = section(() => ({ response: bundle() }));
  await page.h.settle();
  await page.download();
  assert.deepEqual(plain(page.requests()[0].body), { submissionIds: [], aiJobIds: [] });
  assert.equal(page.message("positive"), ".diagnostics.downloaded");
});

test("IDs that aren't IDs, or too many of them, are refused before anything is sent", async () => {
  for (const [field, value, error] of [
    ["diagnostic-submission-ids", "12 abc", ".diagnostics.invalid_ids"],
    ["diagnostic-submission-ids", "0", ".diagnostics.invalid_ids"],
    ["diagnostic-submission-ids", "2147483648", ".diagnostics.invalid_ids"],
    ["diagnostic-ai-job-ids", "not-a-uuid", ".diagnostics.invalid_ids"],
    ["diagnostic-ai-job-ids", "1b4e28ba-2fa1-1d2b-883f-0016d3cca427", ".diagnostics.invalid_ids"],
    ["diagnostic-submission-ids", Array.from({ length: 51 }, (_, i) => i + 1).join(" "), ".diagnostics.too_many"]
  ]) {
    const page = section(() => ({ response: bundle() }));
    await page.h.settle();
    await page.type(field, value);
    await page.download();
    assert.equal(page.requests().length, 0, value);
    assert.equal(page.message("negative"), error, value);
    assert.equal(page.saved.length, 0);
  }
});

test("a refusal or an answer that isn't a bundle is shown, and nothing is saved", async () => {
  const refused = section(() => ({ requestError: () => "Only site administrators", requestErrorStatus: 403 }));
  await refused.h.settle();
  await refused.download();
  assert.equal(refused.message("negative"), "Only site administrators");
  assert.equal(refused.saved.length, 0);

  const odd = section(() => ({ response: { bundle: { bundleVersion: 2 } } }));
  await odd.h.settle();
  await odd.download();
  assert.equal(odd.message("negative"), ".invalid_response");
  assert.equal(odd.saved.length, 0);
});
