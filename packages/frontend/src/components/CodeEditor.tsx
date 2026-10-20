import React, { useRef, useState } from "react";
import { observer } from "mobx-react";
import ReactMonacoEditor from "@monaco-editor/react";
import { registerRulesForLanguage } from "monaco-ace-tokenizer";

import * as Monaco from "monaco-editor";

import style from "./CodeEditor.module.less";

import { CodeLanguage } from "@/interfaces/CodeLanguage";
import { appState } from "@/appState";
import { generateCodeFontEditorOptions } from "@/misc/fonts";
import { themeList } from "@/themes";
import { useLocalizer } from "@/utils/hooks";

// ACE highlights
import AceHighlightHaskell from "monaco-ace-tokenizer/es/ace/definitions/haskell";
Monaco.languages.register({ id: "haskell" });
registerRulesForLanguage("haskell", new AceHighlightHaskell());

// Monaco themes

Object.entries(import.meta.glob("../assets/monaco-themes/*.json", { eager: true, import: "default" })).forEach(
  ([filename, data]) => {
    Monaco.editor.defineTheme(filename.match(/([^/]+)\.json$/)[1], data as any);
  }
);

export interface CodeEditorProps {
  editorDidMount?: (editor: Monaco.editor.IStandaloneCodeEditor) => void;
  className?: string;
  value: string;
  language: CodeLanguage | string;
  onChange?: (newValue: string) => void;
  options?: Monaco.editor.IEditorConstructionOptions;
}

// Monaco's key for toggling whether Tab indents or moves the focus
const tabFocusKey = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌃⇧M" : "Ctrl+M";

let CodeEditor: React.FC<CodeEditorProps> = props => {
  const _ = useLocalizer("components.code_editor");
  const refEditor = useRef<Monaco.editor.IStandaloneCodeEditor>();

  // Tab indents in the editor, so a keyboard user needs to know how to leave it: say so while it has the focus.
  const [focused, setFocused] = useState(false);
  const [tabMovesFocus, setTabMovesFocus] = useState(false);
  const tabHint = _(tabMovesFocus ? ".tab_moves_focus" : ".tab_hint", { key: tabFocusKey });

  function editorDidMount(editor: Monaco.editor.IStandaloneCodeEditor) {
    editor.getModel().setEOL(Monaco.editor.EndOfLineSequence.LF);

    refEditor.current = editor;
    console.log("Monaco Editor:", editor);

    // Monaco keeps whether Tab moves the focus (toggled with the key, or from its command palette) outside the editor's
    // options and events. An action enabled only in that mode reads it, and in the palette makes Tab indent again.
    editor.addAction({
      id: "llmoj.indentWithTab",
      label: _(".indent_with_tab"),
      precondition: "editorTabMovesFocus",
      run: () => editor.trigger("llmoj", "editor.action.toggleTabFocusMode", null)
    });
    const readTabFocusMode = () => setTabMovesFocus(editor.getAction("llmoj.indentWithTab").isSupported());
    readTabFocusMode();
    editor.onDidFocusEditorText(() => {
      readTabFocusMode();
      setFocused(true);
    });
    editor.onDidBlurEditorText(() => setFocused(false));
    editor.onKeyUp(readTabFocusMode);

    if (props.editorDidMount) props.editorDidMount(editor);
  }

  // The Monaco Editor's automaticLayout option doesn't work on a initially hidden editor
  // So follow the container's size instead
  const containerRef = useRef<HTMLDivElement>();
  const resizeObserverRef = useRef<ResizeObserver>();
  function initializeResizeObserver(div: HTMLDivElement) {
    if (containerRef.current !== div) {
      resizeObserverRef.current?.disconnect();
      if (div) {
        resizeObserverRef.current = new ResizeObserver(() => {
          if (refEditor.current) refEditor.current.layout();
        });
        resizeObserverRef.current.observe(div);
      } else resizeObserverRef.current = null;
      containerRef.current = div;
    }
  }

  return (
    <div
      ref={initializeResizeObserver}
      className={props.className ? `${style.editorContainer} ${props.className}` : style.editorContainer}
    >
      <ReactMonacoEditor
        theme={themeList[appState.theme].editor}
        language={
          (
            {
              bash: "shell",
              elisp: "scheme",
              assembly: "plaintext",
              awk: "plaintext",
              sed: "plaintext",
              dc: "plaintext",
              bc: "plaintext"
            } as Record<string, string>
          )[props.language] || props.language
        }
        value={props.value}
        options={{
          lineNumbersMinChars: 4,
          // Monaco now colours bracket pairs by default; brackets keep the themes' colours, as before
          bracketPairColorization: { enabled: false },
          ariaLabel: `${_(".label")}. ${tabHint}`,
          ...generateCodeFontEditorOptions(appState.locale),
          ...props.options
        }}
        onMount={editorDidMount}
        onChange={props.onChange}
      />
      {focused && !props.options?.readOnly && (
        <div className={style.keyboardHint} aria-hidden="true">
          {tabHint}
        </div>
      )}
    </div>
  );
};

CodeEditor = observer(CodeEditor);

export default CodeEditor;
