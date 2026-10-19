// Run: node --test packages/frontend/test/locale-parity.test.cjs
// A message missing from one language shows as its raw ID (e.g. "problem_judge_settings.file_selector.empty"), and a
// placeholder missing from a translation drops a value from the sentence. Both languages must have the same messages
// with the same placeholders.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const messages = path.join(__dirname, "../src/locales/messages");

// The home page countdown is worded differently in each language, so each has its own set of messages.
const LANGUAGE_SPECIFIC = [/^home\.countdown\./];
// Placeholders a language leaves out on purpose
const OMITTED_PLACEHOLDERS = {
  // IP locations are only looked up in Chinese
  "user_edit.security.sessions.login_ip_location": ["{location}"]
};

function load(locale) {
  const flat = {};
  function walk(directory, prefix) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file, prefix + entry.name + ".");
      else if (entry.name.endsWith(".js")) {
        // Each file is the body of a function returning the messages (see importMessages.ts)
        const tree = new Function(fs.readFileSync(file, "utf8"))();
        (function flatten(value, id) {
          if (typeof value === "string") flat[id] = value;
          else for (const key in value) flatten(value[key], `${id}.${key}`);
        })(tree, prefix + entry.name.slice(0, -3));
      }
    }
  }
  walk(path.join(messages, locale), "");
  return flat;
}
const shared = id => !LANGUAGE_SPECIFIC.some(pattern => pattern.test(id));
const placeholders = text => [...new Set(text.match(/\{[^{}]+\}/g) || [])].sort();

const english = load("en-US"),
  chinese = load("zh-CN");

test("English and Chinese have the same messages", () => {
  assert.ok(Object.keys(english).length > 1000, "the messages were found");
  assert.deepEqual(
    Object.keys(chinese).filter(id => shared(id) && !(id in english)),
    [],
    "missing in English"
  );
  assert.deepEqual(
    Object.keys(english).filter(id => shared(id) && !(id in chinese)),
    [],
    "missing in Chinese"
  );
});

test("a translation keeps every placeholder of its message", () => {
  const differing = Object.keys(english)
    .filter(id => shared(id) && id in chinese)
    .filter(id => {
      const omitted = OMITTED_PLACEHOLDERS[id] || [];
      const without = text => placeholders(text).filter(placeholder => !omitted.includes(placeholder));
      return without(english[id]).join() !== without(chinese[id]).join();
    })
    .map(id => `${id}: ${placeholders(english[id]).join(" ")} / ${placeholders(chinese[id]).join(" ")}`);
  assert.deepEqual(differing, []);
});
