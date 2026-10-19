// Run: node --test packages/frontend/test/keyboard-access.test.cjs
// Every control must work without a mouse. Semantic UI renders a menu item, label or icon that only has an onClick as an
// element Tab never reaches (an <a> without href, an <i>), and a dropdown built from <Dropdown.Item> children opens from
// the keyboard but its items can't be chosen. These tests find such controls in the source and check the helpers that
// fix them (utils/keyboard.ts).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");
const src = path.join(__dirname, "../src");

function sourceFiles(directory = src) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "api-generated" ? [] : sourceFiles(file);
    return entry.name.endsWith(".tsx") ? [file] : [];
  });
}

// Elements that show something to click on but aren't focusable unless given an href (or the helpers' props)
const CONTROL_LIKE = new Set([
  "a",
  "Menu.Item",
  "Dropdown.Item",
  "Label",
  "Icon",
  "List.Item",
  "Step",
  "Breadcrumb.Section",
  "Image",
  "img",
  "i"
]);

function tagName(node) {
  return node.tagName.getText();
}
function attributes(node) {
  return node.attributes.properties;
}
function attribute(node, name) {
  return attributes(node).find(property => ts.isJsxAttribute(property) && property.name.getText() === name);
}
function spreads(node, name) {
  return attributes(node).some(property => ts.isJsxSpreadAttribute(property) && property.expression.getText() === name);
}
function attributeText(node, name) {
  const found = attribute(node, name);
  if (!found || !found.initializer) return found ? "true" : null;
  return ts.isStringLiteral(found.initializer) ? found.initializer.text : found.initializer.expression?.getText() ?? "";
}
function openingElement(node) {
  return ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
}
// The <Dropdown> an item belongs to
function owningDropdown(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    const opening = openingElement(parent);
    if (opening && tagName(opening) === "Dropdown") return opening;
  }
  return null;
}
// The element is the trigger of a <Popup> that opens on click (Popup adds its own onClick to it)
function isClickPopupTrigger(node) {
  const element = node.parent && ts.isJsxOpeningElement(node) ? node.parent : node;
  const expression = element.parent;
  if (!expression || !ts.isJsxExpression(expression)) return false;
  const triggerAttribute = expression.parent;
  if (!triggerAttribute || !ts.isJsxAttribute(triggerAttribute) || triggerAttribute.name.getText() !== "trigger")
    return false;
  const popup = triggerAttribute.parent.parent;
  return tagName(popup) === "Popup" && /click/.test(attributeText(popup, "on") || "");
}

function findUnreachableControls(file) {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const problems = [];
  function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const name = tagName(node);
      const clickable = !!attribute(node, "onClick") || isClickPopupTrigger(node);
      if (CONTROL_LIKE.has(name) && clickable) {
        const as = attributeText(node, "as");
        const reachable =
          spreads(node, "actsAsButton") ||
          !!attribute(node, "href") ||
          !!attribute(node, "tabIndex") ||
          (as !== null && as !== "a") ||
          (name === "Dropdown.Item" && isChosenByDropdown(node));
        if (!reachable) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart());
          problems.push(`${path.relative(src, file)}:${line + 1} <${name}>`);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  // A <Dropdown.Item> is chosen from the keyboard by its dropdown when the dropdown has keyboardMenu (a hover menu,
  // `simple`, has no keyboard handling: its items must be focusable themselves). Items made apart from their dropdown
  // (in a list rendered into it later) count when the file's dropdowns made of items have keyboardMenu.
  const fileHasKeyboardMenu = /<Dropdown\b[^>]*\{\.\.\.keyboardMenu\}/.test(source.text);
  function isChosenByDropdown(node) {
    const dropdown = owningDropdown(node);
    if (!dropdown) return fileHasKeyboardMenu;
    return spreads(dropdown, "keyboardMenu") && !attribute(dropdown, "simple");
  }
  visit(source);
  return problems;
}

test("every clickable menu item, label, icon and link can be reached and pressed with the keyboard", () => {
  const problems = sourceFiles().flatMap(findUnreachableControls);
  assert.deepEqual(
    problems,
    [],
    "Spread actsAsButton on these (or keyboardMenu on their <Dropdown>), give them an href, or use a <Button>:\n" +
      problems.join("\n")
  );
});

test("the guard finds the patterns it is meant to find", () => {
  const sample = path.join(require("node:os").tmpdir(), `keyboard-access-${process.pid}.tsx`);
  fs.writeFileSync(
    sample,
    `const a = <Menu.Item onClick={f} />;
const b = <Menu.Item {...actsAsButton} onClick={f} />;
const c = <Popup on="click" trigger={<Menu.Item name="x" />} />;
const d = <Label as="a" onClick={f}>x</Label>;
const e = <Label as={Link} href="/x" onClick={f}>x</Label>;
const g = <Dropdown><Dropdown.Menu><Dropdown.Item onClick={f} /></Dropdown.Menu></Dropdown>;
const h = <Dropdown {...keyboardMenu}><Dropdown.Menu><Dropdown.Item onClick={f} /></Dropdown.Menu></Dropdown>;
const i = <Dropdown simple {...keyboardMenu}><Dropdown.Menu><Dropdown.Item onClick={f} /></Dropdown.Menu></Dropdown>;
const j = <Icon name="delete" onClick={f} />;
const k = <Popup on="hover" trigger={<Icon name="info" />} />;`
  );
  try {
    const found = findUnreachableControls(sample).map(problem => problem.replace(/^.*:(\d+) /, "$1 "));
    assert.deepEqual(found, [
      "1 <Menu.Item>",
      "3 <Menu.Item>",
      "4 <Label>",
      "6 <Dropdown.Item>",
      "8 <Dropdown.Item>",
      "9 <Icon>"
    ]);
  } finally {
    fs.rmSync(sample);
  }
});

// Loads utils/keyboard.ts with a minimal DOM: elements with classes, attributes, children and a focus.
function loadKeyboard() {
  const module = { exports: {} };
  const frames = [];
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(path.join(src, "utils/keyboard.ts"), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
    }).outputText,
    {
      module,
      exports: module.exports,
      HTMLElement: FakeElement,
      requestAnimationFrame: callback => frames.push(callback),
      document: {}
    }
  );
  return { keyboard: module.exports, frames };
}
class FakeElement {
  constructor(className = "", children = []) {
    this.classList = new Set(className.split(" ").filter(Boolean));
    this.classList.contains = this.classList.has;
    this.attributes = new Map();
    this.children = children;
    this.clicks = 0;
    this.id = "";
    for (const child of children) child.parent = this;
  }
  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  matches(selector) {
    return selector === "[data-keyboard-menu]" && this.hasAttribute("data-keyboard-menu");
  }
  getClientRects() {
    return this.hidden ? [] : [{}];
  }
  click() {
    this.clicks++;
  }
  querySelectorAll(selector) {
    if (selector === ":scope > .menu > .item")
      return this.children
        .filter(c => c.classList.has("menu"))
        .flatMap(menu => menu.children.filter(c => c.classList.has("item")));
    if (selector === "[data-keyboard-highlight]") {
      const all = [];
      const walk = element => element.children.forEach(child => (all.push(child), walk(child)));
      walk(this);
      return all.filter(element => element.hasAttribute("data-keyboard-highlight"));
    }
    throw new Error("Unexpected selector " + selector);
  }
}
function key(target, name, modifiers = {}) {
  const event = { target, key: name, defaultPrevented: false, stopped: false, ...modifiers };
  event.preventDefault = () => (event.defaultPrevented = true);
  event.stopPropagation = () => (event.stopped = true);
  return event;
}

test("a keyboard menu moves through its shown, enabled items with the arrow keys and chooses one with Enter", () => {
  const { keyboard, frames } = loadKeyboard();
  const items = [
    new FakeElement("item"),
    new FakeElement("item disabled"),
    new FakeElement("item"),
    new FakeElement("item")
  ];
  items[3].hidden = true;
  const dropdown = new FakeElement("ui dropdown", [new FakeElement("menu", items)]);
  dropdown.setAttribute("data-keyboard-menu", "");

  // Closed: the dropdown opens itself on the arrow key, and its first item is picked once it shows
  let event = key(dropdown, "ArrowDown");
  keyboard.onKeyboardMenuKeyDown(event);
  assert.equal(event.defaultPrevented, false, "Semantic UI still opens it");
  dropdown.classList.add("active");
  frames.shift()();
  assert.ok(items[0].hasAttribute("data-keyboard-highlight"));
  assert.equal(dropdown.attributes.get("aria-activedescendant"), items[0].id);

  event = key(dropdown, "ArrowDown");
  keyboard.onKeyboardMenuKeyDown(event);
  assert.ok(event.defaultPrevented && event.stopped);
  assert.ok(items[2].hasAttribute("data-keyboard-highlight"), "the disabled item is skipped");
  assert.ok(!items[0].hasAttribute("data-keyboard-highlight"));
  keyboard.onKeyboardMenuKeyDown(key(dropdown, "ArrowDown"));
  assert.ok(items[0].hasAttribute("data-keyboard-highlight"), "wraps around past the hidden item");
  keyboard.onKeyboardMenuKeyDown(key(dropdown, "ArrowUp"));
  assert.ok(items[2].hasAttribute("data-keyboard-highlight"));

  event = key(dropdown, "Enter");
  keyboard.onKeyboardMenuKeyDown(event);
  assert.ok(event.defaultPrevented && event.stopped, "not also taken as a click on the dropdown");
  assert.equal(items[2].clicks, 1);
  assert.ok(!items[2].hasAttribute("data-keyboard-highlight"));
  assert.equal(dropdown.attributes.has("aria-activedescendant"), false);

  // Nothing picked: Enter is left to the dropdown (it closes); other dropdowns and modified keys are left alone
  event = key(dropdown, "Enter");
  keyboard.onKeyboardMenuKeyDown(event);
  assert.equal(event.defaultPrevented, false);
  const plain = new FakeElement("ui dropdown active", [new FakeElement("menu", [new FakeElement("item")])]);
  event = key(plain, "ArrowDown");
  keyboard.onKeyboardMenuKeyDown(event);
  assert.equal(event.defaultPrevented, false);
  event = key(dropdown, "ArrowDown", { altKey: true });
  keyboard.onKeyboardMenuKeyDown(event);
  assert.equal(event.defaultPrevented, false);
});

test("actsAsButton makes an element focusable and presses it with Enter or Space", () => {
  const { keyboard } = loadKeyboard();
  assert.equal(keyboard.actsAsButton.tabIndex, 0);
  assert.equal(keyboard.actsAsButton.role, "button");
  const element = new FakeElement();
  for (const [name, pressed] of [
    ["Enter", true],
    [" ", true],
    ["a", false]
  ]) {
    const event = key(element, name);
    event.currentTarget = element;
    keyboard.actsAsButton.onKeyDown(event);
    assert.equal(event.defaultPrevented, pressed, name);
  }
  assert.equal(element.clicks, 2);
  // A key pressed in something inside it (an input in a menu item) is that element's own
  const event = key(new FakeElement(), "Enter");
  event.currentTarget = element;
  keyboard.actsAsButton.onKeyDown(event);
  assert.equal(element.clicks, 2);
});
