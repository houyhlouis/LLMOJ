// Real page handlers and typed response validation; API transport and DOM widgets are mocked.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { componentHarness } = require("./helpers/component-harness.cjs");
const page = "pages/site-management/index.tsx";
const get = "site-management/getSettings";
const post = "site-management/updateRegistrationMode";
const settings = (registrationMode = "open", usesOverride = false, configuredRegistrationMode = "open") => ({
  registrationMode,
  usesOverride,
  configuredRegistrationMode
});
const buttonText = (props, text) => props.children.flat(Infinity).includes(text);
async function choose(h, value) {
  h.find("Dropdown").props.onChange(null, { value });
  await h.settle();
}
async function save(h) {
  await h.click("Button", p => buttonText(p, ".save"));
}

for (const options of [{}, { user: true }, { user: true, privileges: ["ManageRegistrationReviews", "EditHomepage"] }]) {
  test(`site settings deny ${
    options.privileges ? "delegated reviewers and homepage editors" : options.user ? "ordinary users" : "guests"
  }`, async () => {
    const h = componentHarness(page, options);
    await h.settle();
    assert.equal(h.find("Message").props.content, ".permission_denied");
    assert.equal(h.calls.length, 0);
  });
}

test("loading authoritative settings updates registration mode without changing other security flags", async () => {
  const h = componentHarness(page, { admin: true, api: () => ({ response: settings("approval", false, "approval") }) });
  h.state.serverPreference.security.requireEmailVerification = true;
  await h.settle();
  assert.equal(h.calls[0].name, get);
  assert.equal(h.calls[0].body, undefined);
  assert.equal(h.state.serverPreference.security.registrationMode, "approval");
  assert.equal(h.state.serverPreference.security.requireEmailVerification, true);
  assert.equal(h.find("Dropdown").props.value, "approval");
  assert.equal(h.find("Button", p => buttonText(p, ".save")).props.disabled, true);
  assert.equal(h.find("Button", p => buttonText(p, ".restore")).props.disabled, true);
});

for (const mode of ["open", "approval", "closed"]) {
  test(`saving ${mode} sends the selected mode and updates state only after confirmation`, async () => {
    const initial = mode === "open" ? "approval" : "open";
    const h = componentHarness(page, {
      admin: true,
      api: name => ({ response: name === get ? settings(initial, false, initial) : settings(mode, true, initial) })
    });
    await h.settle();
    await choose(h, mode);
    assert.equal(h.state.serverPreference.security.registrationMode, initial);
    assert.equal(h.confirmations.at(-1), true);
    await save(h);
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls.find(x => x.name === post).body)), { registrationMode: mode });
    assert.equal(h.state.serverPreference.security.registrationMode, mode);
    assert.equal(h.find("Message", p => p.positive).props.content, ".saved");
    assert.equal(h.find("Button", p => buttonText(p, ".save")).props.disabled, true);
    assert.equal(h.confirmations.at(-1), false);
  });
}

test("restore sends null and adopts the server's returned configuration rather than a stale local value", async () => {
  const h = componentHarness(page, {
    admin: true,
    api: name => ({
      response: name === get ? settings("closed", true, "open") : settings("approval", false, "approval")
    })
  });
  await h.settle();
  await choose(h, "open");
  await h.click("Button", p => buttonText(p, ".restore"));
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.find(x => x.name === post).body)), { registrationMode: null });
  assert.equal(h.state.serverPreference.security.registrationMode, "approval");
  assert.equal(h.find("Dropdown").props.value, "approval");
  assert.equal(h.find("Message", p => p.positive).props.content, ".restored");
  assert.equal(h.find("Button", p => buttonText(p, ".restore")).props.disabled, true);
});

test("failed saves retain the draft and last confirmed mode without showing success", async () => {
  const h = componentHarness(page, {
    admin: true,
    api: name => (name === get ? { response: settings() } : { requestErrorStatus: 500, requestError: () => "offline" })
  });
  await h.settle();
  await choose(h, "closed");
  await save(h);
  assert.equal(h.state.serverPreference.security.registrationMode, "open");
  assert.equal(h.find("Dropdown").props.value, "closed");
  assert.equal(h.find("Message", p => p.negative).props.content, ".save_unconfirmed");
  assert.equal(h.all(n => n.type?.name === "Message" && n.props.positive).length, 0);
  assert.equal(h.find("Button", p => buttonText(p, ".save")).props.disabled, false);
  assert.equal(h.confirmations.at(-1), true);
});

test("a pending save cannot be submitted twice or replaced by restore", async () => {
  let finish;
  const h = componentHarness(page, {
    admin: true,
    api: name =>
      name === get
        ? { response: settings("open", true) }
        : new Promise(resolve => {
            finish = resolve;
          })
  });
  await h.settle();
  await choose(h, "approval");
  const submit = h.find("Button", p => buttonText(p, ".save")).props.onClick;
  const restore = h.find("Button", p => buttonText(p, ".restore")).props.onClick;
  const first = submit();
  await submit();
  await restore();
  assert.equal(h.calls.filter(x => x.name === post).length, 1);
  finish({ response: settings("approval", true) });
  await first;
  await h.settle();
  assert.equal(h.state.serverPreference.security.registrationMode, "approval");
});

for (const response of [{}, { registrationMode: "unknown", configuredRegistrationMode: "open", usesOverride: false }]) {
  test(`invalid settings responses cannot alter the current mode (${
    Object.keys(response).length
  } fields)`, async () => {
    const h = componentHarness(page, { admin: true, mode: "closed", api: () => ({ response }) });
    await h.settle();
    assert.equal(h.find("Message", p => p.negative).props.content, ".invalid_response");
    assert.equal(h.state.serverPreference.security.registrationMode, "closed");
    assert.equal(h.all(n => n.type?.name === "Dropdown").length, 0);
  });
}

test("a failed load can be retried without sending a mutation", async () => {
  let first = true;
  const h = componentHarness(page, {
    admin: true,
    api: () => {
      if (first) {
        first = false;
        return { requestError: () => "offline" };
      }
      return { response: settings("closed", true) };
    }
  });
  await h.settle();
  assert.equal(h.find("Message", p => p.negative).props.content, "offline");
  await h.click("Button", p => p.content === ".refresh");
  assert.equal(h.find("Dropdown").props.value, "closed");
  assert.equal(h.calls.filter(x => x.name === post).length, 0);
});

for (const accept of [true, false]) {
  test(`reload ${accept ? "discards" : "preserves"} unsaved choices after the user's confirmation`, async () => {
    const h = componentHarness(page, { admin: true, confirm: accept, api: () => ({ response: settings() }) });
    await h.settle();
    await choose(h, "closed");
    await h.click("Button", p => p.content === ".refresh");
    assert.equal(h.calls.filter(x => x.name === get).length, accept ? 2 : 1);
    assert.equal(h.find("Dropdown").props.value, accept ? "open" : "closed");
  });
}

test("HTTP 403 after loading clears management state and blocks a captured stale save handler", async () => {
  const h = componentHarness(page, {
    admin: true,
    api: name =>
      name === get ? { response: settings() } : { requestErrorStatus: 403, requestError: () => "permission denied" }
  });
  await h.settle();
  await choose(h, "closed");
  const submit = h.find("Button", p => buttonText(p, ".save")).props.onClick;
  await submit();
  await h.settle();
  await submit();
  assert.equal(h.find("Message", p => p.negative).props.content, ".permission_denied");
  assert.equal(h.all(n => n.type?.name === "Dropdown").length, 0);
  assert.equal(h.calls.filter(x => x.name === post).length, 1);
  assert.equal(h.state.serverPreference.security.registrationMode, "open");
});

test("revoked administrator access ignores late load responses", async () => {
  let finish;
  const h = componentHarness(page, {
    admin: true,
    api: () =>
      new Promise(resolve => {
        finish = resolve;
      })
  });
  await h.settle();
  h.state.currentUser.isAdmin = false;
  h.render();
  await h.settle();
  finish({ response: settings("closed", true) });
  await h.settle();
  assert.equal(h.state.serverPreference.security.registrationMode, "open");
  assert.equal(h.find("Message").props.content, ".permission_denied");
});

test("a save finishing after unmount cannot mutate global mode or publish success", async () => {
  let finish;
  const h = componentHarness(page, {
    admin: true,
    api: name =>
      name === get
        ? { response: settings() }
        : new Promise(resolve => {
            finish = resolve;
          })
  });
  await h.settle();
  await choose(h, "closed");
  const saving = h.find("Button", p => buttonText(p, ".save")).props.onClick;
  const pending = saving();
  h.unmount();
  finish({ response: settings("closed", true) });
  await pending;
  assert.equal(h.state.serverPreference.security.registrationMode, "open");
});

test("site management locale keys and administrator-only menu match both languages", () => {
  const root = path.join(__dirname, "../src");
  const keys = object =>
    Object.entries(object).flatMap(([key, value]) =>
      typeof value === "object" ? keys(value).map(child => key + "." + child) : [key]
    );
  const messages = ["zh-CN", "en-US"].map(locale =>
    new Function(fs.readFileSync(path.join(root, `locales/messages/${locale}/site_management.js`), "utf8"))()
  );
  assert.deepEqual(keys(messages[0]).sort(), keys(messages[1]).sort());
  const layout = fs.readFileSync(path.join(root, "layouts/AppLayout.tsx"), "utf8");
  const ast = ts.createSourceFile("AppLayout.tsx", layout, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let gate;
  function visit(node) {
    if (ts.isBinaryExpression(node) && node.right.getText(ast).includes('href="/site-management"'))
      gate = node.left.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(gate, "appState.currentUser.isAdmin");
});

const footerModule = { exports: {} };
vm.runInNewContext(
  ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/components/SiteFooterBranding.tsx"), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }).outputText,
  { module: footerModule, exports: footerModule.exports, require }
);
const footer = copyrightNotice =>
  renderToStaticMarkup(React.createElement(footerModule.exports.default, { siteName: "XYZOJ", copyrightNotice }));

test("footer displays the configured site name and links LLMOJ to the maintained repository", () => {
  const html = footer("LLMOJ");
  assert.match(html, /XYZOJ Powered by/);
  assert.match(html, /href="https:\/\/github.com\/houyhlouis\/LLMOJ"/);
  assert.match(html, />LLMOJ<\/a>/);
  assert.equal((html.match(/<div>/g) || []).length, 1);
});
for (const value of ["LibreOJ Open Source Project", "", "   "]) {
  test(`footer does not repeat builtin or blank notice ${JSON.stringify(value)}`, () => {
    assert.equal((footer(value).match(/<div>/g) || []).length, 1);
  });
}
test("footer preserves and safely escapes custom copyright text", () => {
  const html = footer('Team <img src=x onerror="alert(1)"> © 2026');
  assert.match(html, /Team &lt;img/);
  assert.ok(!html.includes("<img"));
  assert.equal((html.match(/<div>/g) || []).length, 2);
});

test("administrator revocation blocks a captured save handler before the next render", async () => {
  const h = componentHarness(page, { admin: true, api: () => ({ response: settings() }) });
  await h.settle();
  await choose(h, "closed");
  const submit = h.find("Button", p => buttonText(p, ".save")).props.onClick;
  h.state.currentUser.isAdmin = false;
  await submit();
  h.render();
  await h.settle();
  assert.equal(h.calls.filter(x => x.name === post).length, 0);
  assert.equal(h.find("Message").props.content, ".permission_denied");
});

test("a late save response after administrator revocation cannot change the confirmed mode", async () => {
  let finish;
  const h = componentHarness(page, {
    admin: true,
    api: name =>
      name === get
        ? { response: settings() }
        : new Promise(resolve => {
            finish = resolve;
          })
  });
  await h.settle();
  await choose(h, "closed");
  const pending = h.find("Button", p => buttonText(p, ".save")).props.onClick();
  h.state.currentUser.isAdmin = false;
  h.render();
  await h.settle();
  finish({ response: settings("closed", true) });
  await pending;
  await h.settle();
  assert.equal(h.state.serverPreference.security.registrationMode, "open");
  assert.equal(h.find("Message").props.content, ".permission_denied");
  assert.equal(h.all(n => n.type?.name === "Dropdown").length, 0);
});
