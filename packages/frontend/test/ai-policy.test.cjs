// The AI section of Site management: real handlers and response validation; API transport and widgets are mocked.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { componentHarness } = require("./helpers/component-harness.cjs");
const page = "pages/site-management/AiPolicySection.tsx";
const get = "site-management/getAiPolicy";
const post = "site-management/updateAiPolicy";
const policy = (values = {}) => ({
  paused: false,
  userDailyTokens: 0,
  userDailyRequests: 0,
  jobRequests: 500,
  concurrentRequests: 16,
  ...values
});
const input = (h, field) => h.find("Form.Input", p => p.label === `.ai.fields.${field}`);
const type = async (h, field, value) => {
  input(h, field).props.onChange(null, { value });
  await h.settle();
};
const saveButton = h => h.find("Button", p => p.children.flat(Infinity).includes(".save"));
const plain = value => JSON.parse(JSON.stringify(value));

test("the AI section shows the saved policy and enables saving only after a change", async () => {
  const h = componentHarness(page, { admin: true, api: () => ({ response: policy({ userDailyTokens: 5000 }) }) });
  await h.settle();
  assert.deepEqual(
    h.calls.map(call => call.name),
    [get]
  );
  assert.equal(input(h, "userDailyTokens").props.value, "5000");
  assert.equal(input(h, "concurrentRequests").props.value, "16");
  assert.equal(h.find("Form.Checkbox").props.checked, false);
  assert.equal(saveButton(h).props.disabled, true);
  await type(h, "userDailyTokens", "5000");
  assert.equal(saveButton(h).props.disabled, true, "the same value is no change");
});

test("saving sends whole numbers and the pause switch, and adopts the server's answer", async () => {
  const saved = policy({ paused: true, userDailyTokens: 200000, jobRequests: 0 });
  const h = componentHarness(page, { admin: true, api: name => ({ response: name === get ? policy() : saved }) });
  await h.settle();
  h.find("Form.Checkbox").props.onChange(null, { checked: true });
  await h.settle();
  await type(h, "userDailyTokens", "200000");
  await type(h, "jobRequests", "0");
  await h.click("Button", p => p.children.flat(Infinity).includes(".save"));
  assert.deepEqual(plain(h.calls.find(call => call.name === post).body), saved);
  assert.equal(h.find("Message", p => p.positive).props.content, ".ai.saved");
  assert.equal(saveButton(h).props.disabled, true);
});

for (const [field, value] of [
  ["userDailyTokens", "-1"],
  ["userDailyRequests", "1.5"],
  ["jobRequests", ""],
  ["jobRequests", "100001"],
  ["concurrentRequests", "0"],
  ["concurrentRequests", "1e2"]
])
  test(`an invalid value (${field} = ${JSON.stringify(value)}) is never sent`, async () => {
    const h = componentHarness(page, { admin: true, api: () => ({ response: policy() }) });
    await h.settle();
    await type(h, field, value);
    await h.click("Button", p => p.children.flat(Infinity).includes(".save"));
    assert(!h.calls.some(call => call.name === post));
    assert.equal(h.find("Message", p => p.negative).props.content, ".ai.invalid");
  });

test("an unrecognized policy from the server isn't shown or editable", async () => {
  const h = componentHarness(page, { admin: true, api: () => ({ response: { paused: "no" } }) });
  await h.settle();
  assert.equal(h.find("Message", p => p.negative).props.content, ".invalid_response");
  assert.equal(h.all(node => node.type?.name === "Form").length, 0);
});

test("a failed save keeps the draft and the last confirmed policy", async () => {
  const h = componentHarness(page, {
    admin: true,
    api: name =>
      name === get
        ? { response: policy() }
        : { requestError: () => "network", requestErrorStatus: 500, response: undefined }
  });
  await h.settle();
  await type(h, "userDailyRequests", "300");
  await h.click("Button", p => p.children.flat(Infinity).includes(".save"));
  assert.equal(h.find("Message", p => p.negative).props.content, ".save_unconfirmed");
  assert.equal(input(h, "userDailyRequests").props.value, "300");
  assert.equal(saveButton(h).props.disabled, false);
});
