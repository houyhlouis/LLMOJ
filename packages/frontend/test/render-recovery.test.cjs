// Run with: node --test packages/frontend/test/render-recovery.test.cjs
// Audit 2026-11-07 F23/F24: content whose formatting fails to render shows its plain text and can be retried (the real
// useMaybeAsyncFunctionResult, HighlightedCodeBox and MarkdownContent), and the tabbed answer editor disposes every
// Monaco model and listener it created (the real TabbedEditor with a stand-in for Monaco).
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { componentHarness } = require("./helpers/component-harness.cjs");

let counter = 0;
const uuid = { v4: () => `id-${++counter}` };
const stub = name => ({ __esModule: true, default: { name }, [name]: { name } });

// Rejections nobody handled during a test fail it
function watchRejections() {
  const seen = [];
  const listener = reason => seen.push(reason);
  process.on("unhandledRejection", listener);
  return () => {
    process.off("unhandledRejection", listener);
    return seen;
  };
}

test("highlighted code that fails to render shows the code as plain text and renders after a retry", async () => {
  const stop = watchRejections();
  let fail = true,
    highlights = 0;
  const highlighter = {
    loadPrism: () => (fail ? Promise.reject(new Error("the highlighter's chunk didn't load")) : undefined),
    highlight: (code, language, callback) => {
      highlights++;
      callback(`<span class="token">${code}</span>`);
    }
  };
  const h = componentHarness("components/CodeBox.tsx", {
    component: "HighlightedCodeBox",
    props: { code: "int main() { return 0; }", language: "cpp" },
    realHooks: ["useMaybeAsyncFunctionResult"],
    deps: {
      uuid,
      ansi_up: { AnsiUp: class {} },
      "./EmojiRenderer": { EmojiRenderer: { name: "EmojiRenderer" } },
      "@/utils/CodeHighlighter": highlighter
    }
  });
  await h.settle();
  await new Promise(resolve => setImmediate(resolve));
  const box = () => h.find("CodeBox", () => true);
  // CodeBox is the file's own component: find its node by the props it gets
  const rendered = () => h.all(node => node.props && "html" in node.props && "content" in node.props)[0];
  assert.equal(rendered().props.html, "", "no half-rendered markup");
  assert.equal(rendered().props.content, "int main() { return 0; }", "the code itself, as text");
  const notice = h.all(node => node.props && typeof node.props.onRetry === "function")[0];
  assert.ok(notice, "a notice offers to try again");
  assert.equal(highlights, 0);

  fail = false;
  notice.props.onRetry();
  await h.settle();
  await new Promise(resolve => setImmediate(resolve));
  await h.settle();
  assert.equal(highlights, 1);
  assert.equal(rendered().props.html, '<span class="token">int main() { return 0; }</span>');
  assert.equal(h.all(node => node.props && typeof node.props.onRetry === "function").length, 0, "the notice is gone");
  assert.deepEqual(stop(), [], "no unhandled rejection");
  void box;
});

test("Markdown that fails to render shows its text as text, never as HTML, and can be tried again", async () => {
  const stop = watchRejections();
  let renders = 0;
  const content = "Hello <b>world</b> $x$";
  const h = componentHarness("markdown/MarkdownContent.tsx", {
    props: { content },
    realHooks: ["useMaybeAsyncFunctionResult"],
    deps: {
      uuid,
      "@twemoji/api": { __esModule: true, default: { parse() {} } },
      "./sanitize": { sanitize: html => html },
      "@/components/EmojiRenderer": { getTwemojiOptions: () => ({}) },
      "@/components/CodeBox": { codeBoxStyle: {} },
      "@/components/RenderFailedNotice": { PlainTextFallback: { name: "PlainTextFallback" } },
      "./markdown": {
        renderMarkdown: () => {
          renders++;
          throw new Error("the Markdown renderer's chunk didn't load");
        }
      }
    }
  });
  await h.settle();
  await new Promise(resolve => setImmediate(resolve));
  await h.settle();
  const fallback = h.find("PlainTextFallback");
  assert.equal(fallback.props.text, content, "the source text, which React escapes");
  assert.equal(h.all(node => node.props?.dangerouslySetInnerHTML).length, 0, "nothing is inserted as HTML");
  assert.equal(h.all(node => node.type?.name === "Placeholder").length, 0, "not left loading");
  assert.equal(renders, 1);

  fallback.props.onRetry();
  await h.settle();
  await new Promise(resolve => setImmediate(resolve));
  await h.settle();
  assert.equal(renders, 2, "a retry renders again");
  assert.ok(h.find("PlainTextFallback"), "and still falls back when it fails again");
  assert.deepEqual(stop(), [], "no unhandled rejection");
});

function fakeMonaco() {
  const models = [];
  let next = 0;
  const monaco = {
    models,
    editor: {
      createModel(value) {
        const listeners = new Set();
        const model = {
          id: ++next,
          value,
          disposed: false,
          listeners,
          getValue: () => model.value,
          setValue(text) {
            model.value = text;
            for (const listener of listeners) listener();
          },
          isDisposed: () => model.disposed,
          dispose() {
            assert.equal(model.disposed, false, `model ${model.id} disposed twice`);
            model.disposed = true;
          },
          onDidChangeContent(listener) {
            listeners.add(listener);
            return { dispose: () => listeners.delete(listener) };
          }
        };
        models.push(model);
        return model;
      }
    }
  };
  return monaco;
}
function fakeEditor(initialModel) {
  let current = initialModel;
  return {
    getModel: () => current,
    setModel(model) {
      current = model;
    },
    saveViewState: () => ({ saved: current?.id }),
    restoreViewState() {}
  };
}

test("the tabbed editor disposes every model and listener it made, on remount and on unmount, never twice", async () => {
  const monaco = fakeMonaco();
  const tabs = ["a.out", "b.out", "c.out"].map((title, i) => ({
    title,
    icon: "file",
    language: "plaintext",
    initialContent: `answer ${i}`
  }));
  const changes = [];
  const h = componentHarness("pages/problem/view/common/TabbedEditor.tsx", {
    props: { tabs, onChange: (index, value) => changes.push([index, value]) },
    window: { Monaco: monaco },
    deps: {
      "@/components/LazyCodeEditor": { __esModule: true, default: { name: "CodeEditor" } },
      "@/components/HorizontalScroll": { __esModule: true, default: { name: "HorizontalScroll" } },
      "@/components/EmojiRenderer": { EmojiRenderer: { name: "EmojiRenderer" } }
    }
  });
  await h.settle();
  const mount = () => {
    const wrapperModel = monaco.editor.createModel("");
    const editor = fakeEditor(wrapperModel);
    h.find("CodeEditor").props.editorDidMount(editor);
    return { editor, wrapperModel };
  };

  const first = mount();
  assert.equal(first.wrapperModel.disposed, true, "the wrapper's empty model, now unused, is disposed");
  const firstTabs = monaco.models.slice(1, 4);
  assert.equal(first.editor.getModel(), firstTabs[0]);
  firstTabs[1].setValue("edited");
  assert.deepEqual(changes, [[1, "edited"]], "edits still reach the page");

  // The editor is mounted again (e.g. the lazy editor reloads): the first tabs' models go
  const second = mount();
  assert.ok(firstTabs.every(model => model.disposed && model.listeners.size === 0));
  const secondTabs = monaco.models.slice(5, 8);
  assert.ok(secondTabs.every(model => !model.disposed));

  // Switching tabs keeps the models; unmounting disposes all of them, after detaching the current one
  h.find("Menu.Item", props => props.content === "c.out").props.onClick();
  await h.settle();
  assert.equal(second.editor.getModel(), secondTabs[2]);
  h.unmount();
  assert.equal(second.editor.getModel(), null, "the editor wrapper won't dispose our model a second time");
  assert.ok(secondTabs.every(model => model.disposed && model.listeners.size === 0));
  assert.ok(
    monaco.models.every(model => model.disposed),
    "no model is left behind"
  );
});
