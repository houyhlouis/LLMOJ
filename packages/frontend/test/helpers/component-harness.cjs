// Shared hook harness: real component handlers, mocked DOM widgets and network calls.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const src = path.join(__dirname, "../../src");

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

function componentHarness(file, options = {}) {
  const slots = [],
    effects = [],
    timers = [],
    calls = [],
    toasts = [],
    confirmations = [];
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
  for (const name of ["createGetApi", "createPostApi"]) {
    api[name] = endpoint => async body => {
      calls.push({ name: endpoint, body });
      return options.api?.(endpoint, body) || { response: {} };
    };
  }

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
      useLocalizer: () => options.localize || localize,
      useConfirmNavigation: () => [
        false,
        value => {
          confirmations.push(value);
        }
      ],
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
    "@/components/TwoFactorPrompt": { name: "TwoFactorPrompt" },
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
  const modules = new Map();
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} };
    modules.set(filename, module);
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
          if (name in deps) return deps[name];
          if (name.startsWith(".")) {
            const resolved = path.resolve(path.dirname(filename), name);
            const target = [resolved, resolved + ".ts", resolved + ".tsx"].find(
              candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile()
            );
            if (target) return load(target);
          }
          throw new Error(`Unexpected import ${name}`);
        },
        setTimeout: fn => timers.push(fn),
        setInterval: () => 0,
        clearInterval() {},
        Date,
        Intl,
        window: { confirm: () => options.confirm !== false }
      },
      { filename }
    );
    return module.exports;
  }
  const exported = load(path.join(src, file));
  component =
    exported.RegistrationReviewPage ||
    observedComponent ||
    (typeof exported.default === "function" ? exported.default : exported.default.view.type);
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
  function unmount() {
    for (const slot of slots) if (slot?.cleanup) slot.cleanup();
  }
  return { state, calls, timers, toasts, confirmations, find, all, settle, click, render, unmount, widgets };
}
module.exports = { componentHarness, frontendCatalog };
