// Run: node --test packages/frontend/test/accessibility.test.cjs
// Sign-in forms that a keyboard and a screen reader can complete, and live views that say when their updates stop.
// The component harness renders the real component code with mocked widgets; the browser checks in the Part 14 guide
// cover the rendered pages.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");
const { componentHarness } = require("./helpers/component-harness.cjs");
const src = path.join(__dirname, "../src");

const login = "pages/auth/login/LoginPage.tsx";
const fields = h => h.all(node => node.type?.name === "Form.Field").map(node => node.props);
const texts = h =>
  h
    .all(() => true)
    .flatMap(node => [node.props?.children].flat(Infinity))
    .filter(child => typeof child === "string");

test("sign-in fields are named and tied to their error messages", () => {
  for (const [file, prefix, mode] of [
    [login, "login", "open"],
    ["pages/auth/register/RegisterPage.tsx", "register", "open"],
    ["pages/auth/forgot/ForgotPage.tsx", "forgot", "open"]
  ]) {
    const h = componentHarness(file, { mode });
    const shown = fields(h);
    assert.ok(shown.length >= 2, file);
    for (const field of shown) {
      // Semantic UI's Form.Field links an error to its control (aria-describedby, aria-invalid) through the id.
      assert.match(field.id, new RegExp(`^${prefix}-`), `${file}: ${field.placeholder}`);
      assert.equal(field["aria-label"], field.placeholder, `${file}: the placeholder isn't the only name`);
    }
    assert.equal(new Set(shown.map(field => field.id)).size, shown.length, `${file}: unique ids`);
  }
});

test("Tab goes from the name to the password, then reaches the forgotten-password link", () => {
  const h = componentHarness(login);
  const order = h
    .all(node => node.type?.name === "Form.Field" || node.type?.name === "PseudoLink")
    .map(node => node.props.id || node.type.name);
  assert.deepEqual(order.slice(0, 3), ["login-username", "login-password", "PseudoLink"]);
  const forgot = h.find("PseudoLink", props => [props.children].flat().includes(".forgot_password"));
  assert.notEqual(forgot.props.tabIndex, -1, "reachable with Tab");
});

test("buttons that send a verification code can be reached with Tab", () => {
  for (const file of ["pages/auth/register/RegisterPage.tsx", "pages/auth/forgot/ForgotPage.tsx"]) {
    const source = fs.readFileSync(path.join(src, file), "utf8");
    assert.doesNotMatch(source, /tabIndex=\{-1\}/, file);
  }
});

test("a successful sign-in is announced", async () => {
  const h = componentHarness(login, { api: () => ({ response: { token: "t", username: "reader" } }) });
  h.find("Form.Field", props => props.id === "login-username").props.onChange({ target: { value: "reader" } });
  h.find("Form.Field", props => props.id === "login-password").props.onChange({ target: { value: "secret" } });
  h.render();
  await h.click("Button", props => !!props.fluid);
  assert.deepEqual(h.announcements, [".welcome"]);
  assert.equal(h.state.token, "t");
});

function liveStatus(props) {
  return componentHarness("components/LiveUpdateStatus.tsx", {
    props,
    deps: { "@/utils/hooks": { useLocalizer: () => id => id } }
  });
}

test("a live view says when its updates stop, offers a reload when they can't resume, and says when they resume", () => {
  let reloads = 0;
  const props = { state: "connected", live: true, onReload: () => reloads++ };
  const h = liveStatus(props);
  assert.equal(h.all(node => node.type?.name === "Message").length, 0);

  props.state = "reconnecting";
  h.render();
  const message = h.find("Message");
  assert.equal(message.props.role, "status", "read out when it appears");
  assert.ok(texts(h).includes(".reconnecting"));
  assert.equal(h.all(node => node.type?.name === "Button").length, 0, "still trying by itself");

  props.state = "offline";
  h.render();
  assert.ok(texts(h).includes(".offline"));
  h.find("Button").props.onClick();
  assert.equal(reloads, 1);

  props.state = "connected";
  h.render();
  assert.equal(h.all(node => node.type?.name === "Message").length, 0);
  assert.deepEqual(h.announcements, [".resumed"]);
});

test("a finished view doesn't warn about lost updates", () => {
  const h = liveStatus({ state: "offline", live: false, onReload() {} });
  assert.equal(h.all(node => node.type?.name === "Message").length, 0);
});

// useSocket with a scripted socket.io client and immediate hooks
function socketHook() {
  const handlers = {},
    managerHandlers = {};
  let state,
    disconnects = 0;
  const socket = {
    on: (event, handler) => (handlers[event] = handler),
    io: { on: (event, handler) => (managerHandlers[event] = handler) },
    disconnect: () => disconnects++
  };
  const module = { exports: {} };
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(path.join(src, "utils/hooks/useSocket.ts"), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
    }).outputText,
    {
      module,
      exports: module.exports,
      console: { log() {} },
      window: { apiEndpoint: "/" },
      require: name =>
        ({
          react: {
            useState: initial => [state ?? initial, value => (state = value)],
            useEffect: callback => callback()
          },
          "socket.io-client": { __esModule: true, default: () => socket },
          "socket.io-msgpack-parser": {}
        }[name])
    }
  );
  let connected = 0;
  const initial = module.exports.useSocket(
    "submission-progress",
    {},
    () => {},
    () => connected++,
    true
  );
  return {
    initial,
    emit: (event, ...args) => handlers[event](...args),
    get state() {
      return state;
    },
    get connected() {
      return connected;
    }
  };
}

test("the live connection is reported as connecting, connected, reconnecting and offline", () => {
  const socket = socketHook();
  assert.equal(socket.initial, "connecting");
  socket.emit("connect");
  assert.equal(socket.state, "connected");
  assert.equal(socket.connected, 1);

  socket.emit("disconnect", "transport close");
  assert.equal(socket.state, "reconnecting");
  for (let attempt = 1; attempt < 5; attempt++) socket.emit("connect_error", new Error("refused"));
  assert.equal(socket.state, "reconnecting", "a few failed attempts");
  socket.emit("connect_error", new Error("refused"));
  assert.equal(socket.state, "offline", "five in a row");
  socket.emit("connect");
  assert.equal(socket.state, "connected", "socket.io kept trying");
  assert.equal(socket.connected, 2);

  // The server ended the subscription: socket.io won't retry
  socket.emit("disconnect", "io server disconnect");
  assert.equal(socket.state, "offline");
  // Leaving the page isn't a lost connection
  socket.emit("connect");
  socket.emit("disconnect", "io client disconnect");
  assert.equal(socket.state, "connected");
});
