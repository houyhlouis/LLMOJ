// Run: node --test packages/frontend/test/registration-review.test.cjs
// Exercise actual component handlers using a small hook harness. These tests do not
// replace the real browser / API integration tests; DOM widgets and APIs are mocked.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");
const src = path.join(__dirname, "../src");

function componentHarness(file, options = {}) {
  const slots = [],
    effects = [],
    timers = [],
    calls = [],
    toasts = [];
  const state = {
    currentUser: options.admin ? { isAdmin: true } : options.user ? { isAdmin: false } : null,
    currentUserPrivileges: [...(options.siteAccess === false ? [] : ["ViewSite"]), ...(options.privileges || [])],
    currentUserHasPrivilege(privilege) {
      return !!this.currentUser && (this.currentUser.isAdmin || this.currentUserPrivileges.includes(privilege));
    },
    locale: "en_US",
    token: "",
    serverPreference: { security: { registrationMode: options.mode || "open" } },
    enterNewPage() {}
  };
  let cursor = 0,
    dirty = false,
    tree,
    component,
    observedComponent;
  function useState(initial) {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
    return [
      slots[index],
      value => {
        slots[index] = typeof value === "function" ? value(slots[index]) : value;
        dirty = true;
      }
    ];
  }
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    Fragment: "Fragment",
    useState,
    useRef(initial) {
      const index = cursor++;
      return (slots[index] ||= { current: initial });
    },
    useEffect(callback, dependencies) {
      const index = cursor++,
        previous = slots[index];
      if (!previous || dependencies.some((x, i) => x !== previous.dependencies[i])) {
        effects.push(() => {
          previous?.cleanup?.();
          slots[index] = { dependencies, cleanup: callback() };
        });
      }
    }
  };
  const widgets = {};
  for (const name of [
    "Header",
    "Checkbox",
    "Segment",
    "Message",
    "Input",
    "Button",
    "Form",
    "Icon",
    "Ref",
    "Dropdown",
    "Label",
    "Loader",
    "Modal",
    "Table"
  ]) {
    // Stable nested widget identities make assertions independent of CSS / markup.
    const nested = new Proxy(
      { name },
      { get: (obj, key) => obj[key] || (obj[key] = { name: `${name}.${String(key)}` }) }
    );
    widgets[name] = nested;
  }
  const api = {
    auth: new Proxy(
      {},
      {
        get: (_, name) => async body => {
          calls.push({ name, body });
          return options.api?.(name, body) || { response: {} };
        }
      }
    )
  };
  api.user = api.auth;
  const localize = id => id;
  const deps = {
    react: React,
    "semantic-ui-react": widgets,
    "mobx-react": { observer: value => (observedComponent = value) },
    navi: { route: value => value },
    "react-navi": { useCurrentRoute: () => ({ url: { query: {} } }) },
    "@/AppRouter": { defineRoute: value => value, RouteError: Error },
    "@/appState": { appState: state },
    "@/locales": { makeToBeLocalizedText: value => value },
    "@/pages/access/permissionCatalog": { permissionCatalog: frontendCatalog() },
    "@/api": api,
    "@/utils/hooks": {
      useLocalizer: () => localize,
      useConfirmNavigation: () => [false, () => {}],
      useNavigationChecked: () => ({ navigate: value => calls.push({ name: "navigate", body: value }) }),
      useLoginOrRegisterNavigation: () => () => {},
      useFieldCheck: value => [() => {}, async () => true, () => false, () => "", () => value],
      useAsyncCallbackPending: callback => [false, callback],
      useDialog: () => ({ element: null, open() {}, close() {} })
    },
    "@/utils/toast": { error: value => toasts.push(value), success: value => toasts.push(value) },
    "@/utils/validators": {
      isValidUsername: () => true,
      isValidEmail: () => true,
      isValidPassword: () => true,
      stripInvalidCharactersInEmailVerificationCode: value => value
    },
    "@/initApp": { refreshSession: async () => calls.push({ name: "refreshSession" }) },
    "@/components/PseudoLink": { name: "PseudoLink" },
    "@/components/UserSearch": { name: "UserSearch" },
    "@/utils/extensionApi": {
      extensionApi: async (name, body) => {
        calls.push({ name, body });
        return options.api?.(name, body) || {};
      }
    },
    "@/utils/onEnterPress": { onEnterPress: callback => callback },
    "class-validator": { isEmail: value => value.includes("@") }
  };
  const filename = path.join(src, file),
    module = { exports: {} };
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        jsx: ts.JsxEmit.React,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        target: ts.ScriptTarget.ES2020
      }
    }).outputText,
    {
      module,
      exports: module.exports,
      require(name) {
        if (name.endsWith(".less")) return {};
        if (!(name in deps)) throw new Error(`Unexpected import ${name}`);
        return deps[name];
      },
      setTimeout: fn => timers.push(fn),
      setInterval: () => 0,
      clearInterval() {},
      Date,
      Intl
    },
    { filename }
  );
  component = module.exports.RegistrationReviewPage || observedComponent || module.exports.default.view.type;
  function render() {
    cursor = 0;
    dirty = false;
    tree = component(options.props || {});
    while (effects.length) effects.shift()();
  }
  async function settle() {
    for (let round = 0; round < 12; round++) {
      if (dirty) render();
      await new Promise(resolve => setImmediate(resolve));
    }
    if (dirty) throw new Error("Unsettled state");
  }
  function all(predicate, node = tree) {
    if (node == null || typeof node !== "object") return [];
    if (Array.isArray(node)) return node.flatMap(child => all(predicate, child ?? null));
    return [...(predicate(node) ? [node] : []), ...(node.props?.children ? all(predicate, node.props.children) : [])];
  }
  function find(name, predicate = () => true) {
    const values = all(node => node.type?.name === name && predicate(node.props));
    assert.ok(values.length, `Missing widget ${name}`);
    return values[0];
  }
  async function click(name, predicate) {
    await find(name, predicate).props.onClick();
    await settle();
  }
  render();
  return { state, calls, timers, toasts, find, all, settle, click, render, widgets };
}
const register = "pages/auth/register/RegisterPage.tsx";
const login = "pages/auth/login/LoginPage.tsx";
const forgot = "pages/auth/forgot/ForgotPage.tsx";
const review = "pages/registration-review/index.tsx";

function fill(h, placeholder, value) {
  h.find("Form.Field", props => props.placeholder === placeholder).props.onChange({ target: { value } });
  h.render();
}
function buttonText(props, text) {
  return props.children.flat(Infinity).includes(text);
}
const application = (id = 1, status = "pending") => ({
  applicationId: id,
  userId: status === "approved" ? 1000 + id : null,
  username: `reader${id}`,
  email: `reader${id}@example.test`,
  registrationTime: "2026-10-10T00:00:00.000Z",
  status,
  reviewedAt: null,
  reviewedBy: null,
  reason: null
});

test("approval registration shows a persistent pending result without session or redirect", async () => {
  const h = componentHarness(register, {
    mode: "approval",
    api: () => ({ response: { registrationStatus: "pending" } })
  });
  fill(h, ".username", "reader");
  fill(h, ".email", "reader@example.test");
  fill(h, ".password", "testpass");
  fill(h, ".retype_password", "testpass");
  await h.click("Button", p => !!p.fluid);
  assert.equal(h.find("Message", p => p.role === "status").props.header, ".pending_title");
  assert.equal(h.state.token, "");
  assert.equal(h.timers.length, 0);
  assert.equal(h.all(n => n.type?.name === "Form").length, 0);
  assert.equal(h.calls.filter(x => x.name === "register").length, 1);
});
test("open registration preserves immediate login behavior", async () => {
  const h = componentHarness(register, {
    api: () => ({ response: { token: "test-token", registrationStatus: "approved" } })
  });
  await h.click("Button", p => !!p.fluid);
  assert.equal(h.state.token, "test-token");
  assert.equal(h.timers.length, 1);
});
test("closed registration hides the form without requesting register or verification", async () => {
  const h = componentHarness(register, { mode: "closed" });
  await h.settle();
  assert.equal(h.find("Message", p => p.role === "status").props.content, ".registration_closed");
  assert.equal(h.all(n => n.type?.name === "Form").length, 0);
  assert.equal(h.calls.length, 0);
});
test("server-side closure after page load replaces the stale registration form", async () => {
  const h = componentHarness(register, { api: () => ({ response: { error: "REGISTRATION_CLOSED" } }) });
  await h.click("Button", p => !!p.fluid);
  assert.equal(h.find("Message", p => p.role === "status").props.content, ".registration_closed");
  assert.equal(h.state.token, "");
});
for (const error of ["REGISTRATION_PENDING", "REGISTRATION_REJECTED"]) {
  test(`login displays ${error} without login or redirect`, async () => {
    const h = componentHarness(login, { api: () => ({ response: { error } }) });
    fill(h, ".username_or_email", "reader");
    fill(h, ".password", "testpass");
    await h.click("Button", p => !!p.fluid);
    assert.equal(h.find("Message", p => p.role === "alert").props.content, `.errors.${error}`);
    assert.equal(h.state.token, "");
    assert.equal(h.timers.length, 0);
  });
  test(`password reset displays ${error} without bypassing approval`, async () => {
    const h = componentHarness(forgot, { api: () => ({ response: { error } }) });
    await h.click("Button", p => !!p.fluid);
    assert.equal(h.find("Message", p => p.role === "alert").props.content, `.errors.${error}`);
    assert.equal(h.state.token, "");
    assert.equal(h.timers.length, 0);
  });
}
test("ordinary users cannot load private review data", async () => {
  const h = componentHarness(review, { user: true });
  await h.settle();
  assert.equal(h.find("Message").props.content, ".errors.PERMISSION_DENIED");
  assert.equal(h.calls.length, 0);
});
test("admin filters and pagination request the selected queue page", async () => {
  const h = componentHarness(review, {
    admin: true,
    api: () => ({ response: { reviews: [application()], count: 21 } })
  });
  await h.settle();
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0].body)), { status: "pending", skipCount: 0, takeCount: 20 });
  await h.click("Button", p => buttonText(p, ".next"));
  assert.equal(h.calls.at(-1).body.skipCount, 20);
  h.find("Dropdown").props.onChange(null, { value: "all" });
  await h.settle();
  assert.equal(h.calls.at(-1).body.skipCount, 0);
  assert.ok(!("status" in h.calls.at(-1).body));
});
for (const decision of ["approved", "rejected"]) {
  test(`admin ${decision} action records the selected application and trimmed note`, async () => {
    let completed = false;
    const h = componentHarness(review, {
      admin: true,
      api: name => {
        if (name === "reviewRegistration") {
          completed = true;
          return { response: { review: application(7, decision) } };
        }
        return { response: { reviews: completed ? [] : [application(7)], count: completed ? 0 : 1 } };
      }
    });
    await h.settle();
    await h.click("Button", p => buttonText(p, decision === "approved" ? ".approve" : ".reject"));
    h.find("Form.TextArea").props.onChange(null, { value: "  Reviewed by teacher  " });
    await h.settle();
    await h.click("Button", p => buttonText(p, ".confirm"));
    const call = h.calls.find(x => x.name === "reviewRegistration");
    assert.deepEqual(JSON.parse(JSON.stringify(call.body)), {
      applicationId: 7,
      decision,
      reason: "Reviewed by teacher"
    });
    assert.equal(h.find("Message", p => p.positive).props.content, `.success.${decision}`);
    assert.equal(h.find("Modal").props.open, false);
  });
}
test("failed review remains visible and refreshes a potentially stale queue", async () => {
  const h = componentHarness(review, {
    admin: true,
    api: name => ({
      response: name === "reviewRegistration" ? { error: "ALREADY_REVIEWED" } : { reviews: [application()], count: 1 }
    })
  });
  await h.settle();
  await h.click("Button", p => buttonText(p, ".approve"));
  await h.click("Button", p => buttonText(p, ".confirm"));
  assert.equal(h.find("Message", p => p.role === "alert").props.content, ".errors.ALREADY_REVIEWED");
  assert.equal(h.find("Modal").props.open, true);
  assert.equal(h.calls.filter(x => x.name === "listRegistrationReviews").length, 2);
});
test("load failure is recoverable with Refresh and approved applications have no action buttons", async () => {
  let first = true;
  const h = componentHarness(review, {
    admin: true,
    api: () => {
      if (first) {
        first = false;
        return { requestError: () => "offline" };
      }
      return { response: { reviews: [application(3, "approved")], count: 1 } };
    }
  });
  await h.settle();
  assert.equal(h.find("Message", p => p.role === "alert").props.content, "offline");
  await h.click("Button", p => p.content === ".refresh");
  assert.equal(h.all(n => n.type?.name === "Button" && buttonText(n.props, ".approve")).length, 0);
});

test("registration review locales expose the same translated keys", () => {
  function keys(object, prefix = "") {
    return Object.entries(object).flatMap(([key, value]) =>
      typeof value === "object" ? keys(value, `${prefix}${key}.`) : [`${prefix}${key}`]
    );
  }
  for (const file of ["registration_review", "register", "login", "forgot", "common"]) {
    const messages = ["zh-CN", "en-US"].map(locale =>
      new Function(fs.readFileSync(path.join(src, "locales/messages", locale, `${file}.js`), "utf8"))()
    );
    assert.deepEqual(keys(messages[0]).sort(), keys(messages[1]).sort(), file);
  }
});

test("an older queue request cannot overwrite a newly selected status", async () => {
  let resolveOld;
  const old = new Promise(resolve => {
    resolveOld = resolve;
  });
  const h = componentHarness(review, {
    admin: true,
    api: (_, body) =>
      body.status === "pending" ? old : { response: { reviews: [application(2, "approved")], count: 1 } }
  });
  await h.settle();
  h.find("Dropdown").props.onChange(null, { value: "approved" });
  await h.settle();
  resolveOld({ response: { reviews: [application(1)], count: 1 } });
  await h.settle();
  assert.deepEqual(
    h.all(n => n.type === "strong").map(n => n.props.children[0]),
    ["reader2"]
  );
});

test("a review in flight cannot be submitted twice", async () => {
  let finish;
  const pending = new Promise(resolve => {
    finish = resolve;
  });
  const h = componentHarness(review, {
    admin: true,
    api: name => (name === "reviewRegistration" ? pending : { response: { reviews: [application()], count: 1 } })
  });
  await h.settle();
  await h.click("Button", p => buttonText(p, ".approve"));
  const submit = h.find("Button", p => buttonText(p, ".confirm")).props.onClick;
  const first = submit();
  await submit();
  assert.equal(h.calls.filter(x => x.name === "reviewRegistration").length, 1);
  finish({ response: { review: application(1, "approved") } });
  await first;
  await h.settle();
});

for (const status of ["pending", "rejected"]) {
  test(`${status} applications show no main-site user ID even if a stale response contains one`, async () => {
    const h = componentHarness(review, {
      admin: true,
      api: () => ({ response: { reviews: [{ ...application(11, status), userId: 12345 }], count: 1 } })
    });
    await h.settle();
    assert.equal(h.all(n => n.type === "span" && n.props.children.includes(".user_id")).length, 0);
    assert.equal(h.all(n => n.type === "a").length, 0);
  });
}

test("only approved applications display their linked user ID", async () => {
  const h = componentHarness(review, {
    admin: true,
    api: () => ({ response: { reviews: [application(11, "approved")], count: 1 } })
  });
  await h.settle();
  assert.equal(h.all(n => n.type === "span" && n.props.children.includes(".user_id")).length, 1);
});

test("review status is plain text while approve/reject retain their action buttons", async () => {
  const h = componentHarness(review, {
    admin: true,
    api: () => ({
      response: { reviews: [application(1), application(2, "approved"), application(3, "rejected")], count: 3 }
    })
  });
  await h.settle();
  const labels = h.all(n => n.props?.["data-registration-status"]);
  assert.deepEqual(
    labels.map(n => n.type),
    ["span", "span", "span"]
  );
  assert.deepEqual(
    labels.map(n => n.props.children[0]),
    [".status.pending", ".status.approved", ".status.rejected"]
  );
  assert.ok(labels.every(n => !n.props.onClick && n.props.role !== "button"));
  assert.equal(h.all(n => n.type?.name === "Label").length, 0);
  assert.equal(h.find("Button", p => buttonText(p, ".approve")).props.positive, true);
  assert.equal(h.find("Button", p => buttonText(p, ".reject")).props.negative, true);
});

for (const error of ["DUPLICATE_USERNAME", "DUPLICATE_EMAIL"]) {
  test(`approval conflict ${error} preserves the application and offers a readable error`, async () => {
    const h = componentHarness(review, {
      admin: true,
      api: name => ({ response: name === "reviewRegistration" ? { error } : { reviews: [application(7)], count: 1 } })
    });
    await h.settle();
    await h.click("Button", p => buttonText(p, ".approve"));
    await h.click("Button", p => buttonText(p, ".confirm"));
    assert.equal(h.find("Message", p => p.role === "alert").props.content, `.errors.${error}`);
    assert.equal(h.find("Modal").props.open, true);
    const sent = h.calls.find(x => x.name === "reviewRegistration").body;
    assert.equal(sent.applicationId, 7);
    assert.equal("userId" in sent, false);
  });
}

for (const error of ["REGISTRATION_PENDING", "REGISTRATION_REJECTED"]) {
  test(`requesting a password-reset code displays ${error} without creating a session`, async () => {
    const h = componentHarness(forgot, { api: () => ({ response: { error } }) });
    await h.find("Form.Field", p => p.placeholder === ".email_verification_code").props.action.props.onClick();
    await h.settle();
    assert.equal(h.find("Message", p => p.role === "alert").props.content, `.errors.${error}`);
    assert.equal(h.calls[0].name, "sendEmailVerificationCode");
    assert.equal(h.calls[0].body.type, "ResetPassword");
    assert.equal(h.state.token, "");
    assert.equal(h.timers.length, 0);
  });
}

for (const options of [{}, { user: true, privileges: ["ManageUser"] }]) {
  test(`${options.user ? "legacy user managers" : "guests"} cannot load registration applications`, async () => {
    const h = componentHarness(review, options);
    await h.settle();
    assert.equal(h.find("Message").props.content, ".errors.PERMISSION_DENIED");
    assert.equal(h.calls.length, 0);
  });
}

for (const role of ["admin", "delegate"]) {
  test(`${role} can approve a rejected application with a specific confirmation and no reject action`, async () => {
    let complete = false;
    const h = componentHarness(review, {
      admin: role === "admin",
      user: role === "delegate",
      privileges: role === "delegate" ? ["ManageRegistrationReviews"] : [],
      api: name => {
        if (name === "reviewRegistration") {
          complete = true;
          return { response: { review: application(9, "approved") } };
        }
        return { response: { reviews: complete ? [] : [application(9, "rejected")], count: complete ? 0 : 1 } };
      }
    });
    await h.settle();
    assert.equal(h.all(n => n.type?.name === "Button" && buttonText(n.props, ".reject")).length, 0);
    await h.click("Button", p => buttonText(p, ".approve"));
    assert.equal(h.find("Modal.Header").props.children[0], ".confirm_reapprove");
    assert.equal(h.all(n => n.type === "p" && n.props.children.includes(".reapprove_notice")).length, 1);
    h.find("Form.TextArea").props.onChange(null, { value: "  Additional information verified  " });
    await h.settle();
    await h.click("Button", p => buttonText(p, ".confirm"));
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls.find(x => x.name === "reviewRegistration").body)), {
      applicationId: 9,
      decision: "approved",
      reason: "Additional information verified"
    });
    assert.equal(h.find("Message", p => p.positive).props.content, ".success.approved");
  });
}

test("delegated reviewers can reject pending applications but approved accounts have no review actions", async () => {
  const h = componentHarness(review, {
    user: true,
    privileges: ["ManageRegistrationReviews"],
    api: name => ({
      response:
        name === "reviewRegistration"
          ? { review: application(2, "rejected") }
          : {
              reviews: [application(2), application(3, "approved")],
              count: 2
            }
    })
  });
  await h.settle();
  assert.equal(h.all(n => n.type?.name === "Button" && buttonText(n.props, ".approve")).length, 1);
  assert.equal(h.all(n => n.type?.name === "Button" && buttonText(n.props, ".reject")).length, 1);
  await h.click("Button", p => buttonText(p, ".reject"));
  assert.equal(h.find("Modal.Header").props.children[0], ".confirm_reject");
  await h.click("Button", p => buttonText(p, ".confirm"));
  assert.equal(h.calls.find(x => x.name === "reviewRegistration").body.decision, "rejected");
});

test("revoking the review privilege blocks an already captured submit handler and removes private data", async () => {
  const h = componentHarness(review, {
    user: true,
    privileges: ["ManageRegistrationReviews"],
    api: () => ({ response: { reviews: [application(9, "rejected")], count: 1 } })
  });
  await h.settle();
  await h.click("Button", p => buttonText(p, ".approve"));
  const staleSubmit = h.find("Button", p => buttonText(p, ".confirm")).props.onClick;
  h.state.currentUserPrivileges = [];
  await staleSubmit();
  h.render();
  await h.settle();
  assert.equal(h.calls.filter(x => x.name === "reviewRegistration").length, 0);
  assert.equal(h.find("Message").props.content, ".errors.PERMISSION_DENIED");
  assert.equal(h.all(n => n.type === "strong" || n.type?.name === "Modal").length, 0);
});

test("a queue response arriving after permission revocation cannot restore private application data", async () => {
  let resolveQueue;
  const h = componentHarness(review, {
    user: true,
    privileges: ["ManageRegistrationReviews"],
    api: () =>
      new Promise(resolve => {
        resolveQueue = resolve;
      })
  });
  await h.settle();
  h.state.currentUserPrivileges = [];
  h.render();
  await h.settle();
  resolveQueue({ response: { reviews: [application()], count: 1 } });
  await h.settle();
  assert.equal(h.find("Message").props.content, ".errors.PERMISSION_DENIED");
  assert.equal(h.all(n => n.type === "strong").length, 0);
});

test("a server permission denial clears the selected application and cached review list", async () => {
  const h = componentHarness(review, {
    user: true,
    privileges: ["ManageRegistrationReviews"],
    api: name => ({
      response: name === "reviewRegistration" ? { error: "PERMISSION_DENIED" } : { reviews: [application()], count: 1 }
    })
  });
  await h.settle();
  await h.click("Button", p => buttonText(p, ".approve"));
  await h.click("Button", p => buttonText(p, ".confirm"));
  assert.equal(h.find("Message", p => p.role === "alert").props.content, ".errors.PERMISSION_DENIED");
  assert.equal(h.find("Modal").props.open, false);
  assert.equal(h.all(n => n.type === "strong").length, 0);
});

test("review completion arriving after revocation does not expose a success message or reload the private queue", async () => {
  let finish;
  const h = componentHarness(review, {
    user: true,
    privileges: ["ManageRegistrationReviews"],
    api: name =>
      name === "reviewRegistration"
        ? new Promise(resolve => {
            finish = resolve;
          })
        : { response: { reviews: [application()], count: 1 } }
  });
  await h.settle();
  await h.click("Button", p => buttonText(p, ".approve"));
  const pending = h.find("Button", p => buttonText(p, ".confirm")).props.onClick();
  h.state.currentUserPrivileges = [];
  h.render();
  await h.settle();
  finish({ response: { review: application(1, "approved") } });
  await pending;
  await h.settle();
  assert.equal(h.find("Message").props.content, ".errors.PERMISSION_DENIED");
  assert.equal(h.calls.filter(x => x.name === "listRegistrationReviews").length, 1);
  assert.equal(h.all(n => n.type?.name === "Message" && n.props.positive).length, 0);
});

function frontendCatalog() {
  const module = { exports: {} };
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(path.join(src, "pages/access/permissionCatalog.ts"), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS }
    }).outputText,
    { module, exports: module.exports }
  );
  return module.exports.permissionCatalog;
}

test("the administrator permissions page displays and saves a delegated registration review grant", async () => {
  const permission = frontendCatalog().find(x => x.key === "ManageRegistrationReviews");
  assert.ok(permission);
  assert.equal(permission.category, "management");
  assert.equal(permission.defaultValue, false);
  assert.ok(permission.zh.includes("拒绝后批准"));
  assert.ok(permission.en.includes("after rejection"));
  const h = componentHarness("pages/access/index.tsx", {
    admin: true,
    api: (name, body) => {
      if (name === "access/catalog") return { catalog: [permission] };
      if (name === "access/get")
        return { user: { id: 7, username: "wenlan", isAdmin: false }, overrides: {}, effective: [] };
      if (name === "access/set") return { overrides: body.overrides, effective: [permission.key] };
    }
  });
  await h.settle();
  await h.find("UserSearch").props.onResultSelect({ id: 7 });
  await h.settle();
  assert.equal(h.all(n => n.type === "strong" && n.props.children[0] === permission.en).length, 1);
  h.find("Dropdown").props.onChange(null, { value: "allow" });
  await h.settle();
  await h.click("Button", p => buttonText(p, "Save permissions"));
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.find(x => x.name === "access/set").body)), {
    userId: 7,
    overrides: { ManageRegistrationReviews: true }
  });
});

test("a delegated reviewer cannot administer the permission catalog", async () => {
  const h = componentHarness("pages/access/index.tsx", { user: true, privileges: ["ManageRegistrationReviews"] });
  await h.settle();
  assert.equal(h.find("Message").props.content, "Administrator access required.");
  assert.equal(h.calls.length, 0);
});

test("the review menu uses the effective privilege and preserves administrator access", () => {
  const filename = path.join(src, "layouts/AppLayout.tsx");
  const ast = ts.createSourceFile(
    filename,
    fs.readFileSync(filename, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  let condition;
  function visit(node) {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      node.right.getText(ast).includes('href="/registration-reviews"')
    )
      condition = node.left.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(condition);
  const check = new Function("appState", "return !!(" + condition + ")");
  for (const [user, privileges, expected] of [
    [null, [], false],
    [{ isAdmin: false }, ["ViewSite"], false],
    [{ isAdmin: false }, ["ViewSite", "ManageUser"], false],
    [{ isAdmin: false }, ["ViewSite", "ManageRegistrationReviews"], true],
    [{ isAdmin: false }, ["ManageRegistrationReviews"], false],
    [{ isAdmin: true }, [], true]
  ]) {
    const appState = {
      currentUser: user,
      currentUserPrivileges: privileges,
      currentUserHasPrivilege(key) {
        return !!this.currentUser && (this.currentUser.isAdmin || this.currentUserPrivileges.includes(key));
      }
    };
    assert.equal(check(appState), expected);
  }
});

test("site access denial also blocks a delegated reviewer", async () => {
  const h = componentHarness(review, { user: true, siteAccess: false, privileges: ["ManageRegistrationReviews"] });
  await h.settle();
  assert.equal(h.find("Message").props.content, ".errors.PERMISSION_DENIED");
  assert.equal(h.calls.length, 0);
});

test("a queue permission denial closes an open confirmation even before local permissions refresh", async () => {
  let loads = 0;
  const h = componentHarness(review, {
    user: true,
    privileges: ["ManageRegistrationReviews"],
    api: () => ({
      response: ++loads === 1 ? { reviews: [application(6, "rejected")], count: 1 } : { error: "PERMISSION_DENIED" }
    })
  });
  await h.settle();
  await h.click("Button", p => buttonText(p, ".approve"));
  h.find("Form.TextArea").props.onChange(null, { value: "Private review note" });
  await h.settle();
  await h.click("Button", p => p.content === ".refresh");
  assert.equal(h.find("Modal").props.open, false);
  assert.equal(h.find("Form.TextArea").props.value, "");
  assert.equal(h.find("Message", p => p.role === "alert").props.content, ".errors.PERMISSION_DENIED");
  assert.equal(h.all(n => n.type === "strong").length, 0);
});

for (const error of ["DUPLICATE_USERNAME", "DUPLICATE_EMAIL"]) {
  test(`a rejected application remains reviewable after approval conflict ${error}`, async () => {
    const h = componentHarness(review, {
      user: true,
      privileges: ["ManageRegistrationReviews"],
      api: name => ({
        response: name === "reviewRegistration" ? { error } : { reviews: [application(7, "rejected")], count: 1 }
      })
    });
    await h.settle();
    await h.click("Button", p => buttonText(p, ".approve"));
    await h.click("Button", p => buttonText(p, ".confirm"));
    assert.equal(h.find("Message", p => p.role === "alert").props.content, `.errors.${error}`);
    assert.equal(h.find("Modal").props.open, true);
    assert.equal(h.all(n => n.props?.["data-registration-status"] === "rejected").length, 1);
    assert.equal(h.all(n => n.type?.name === "Button" && buttonText(n.props, ".reject")).length, 0);
  });
}

test("the legacy privilege editor exposes and preserves the new registration review privilege", async () => {
  const h = componentHarness("pages/user/edit/PrivilegeView.tsx", {
    admin: true,
    props: { meta: { id: 7, username: "wenlan" }, privileges: ["ManageRegistrationReviews", "ViewSite"] },
    api: () => ({ response: {} })
  });
  await h.settle();
  const permission = frontendCatalog().find(x => x.key === "ManageRegistrationReviews");
  assert.equal(h.find("Checkbox", p => p.label === permission.en).props.checked, true);
  await h.click("Button", p => p.content === ".submit");
  assert.equal(
    h.calls.find(x => x.name === "setUserPrivileges").body.privileges.includes("ManageRegistrationReviews"),
    true
  );
});
