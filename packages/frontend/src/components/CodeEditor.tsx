import React, { useRef, useState } from "react";
import { observer } from "mobx-react";
import ReactMonacoEditor from "@monaco-editor/react";
import { registerRulesForLanguage } from "monaco-ace-tokenizer";
import ResizeSensor from "css-element-queries/src/ResizeSensor";
import path from "path";

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

Object.entries(import.meta.globEager("../assets/monaco-themes/*.json")).forEach(([filename, data]) => {
  Monaco.editor.defineTheme(path.basename(filename, ".json"), data as any);
});

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

    const readTabFocusMode = () => setTabMovesFocus(editor.getOption(Monaco.editor.EditorOption.tabFocusMode));
    readTabFocusMode();
    editor.onDidFocusEditorText(() => {
      readTabFocusMode();
      setFocused(true);
    });
    editor.onDidBlurEditorText(() => setFocused(false));
    editor.onDidChangeConfiguration(event => {
      if (event.hasChanged(Monaco.editor.EditorOption.tabFocusMode)) readTabFocusMode();
    });

    if (props.editorDidMount) props.editorDidMount(editor);
  }

  // The Monaco Editor's automaticLayout option doesn't work on a initially hidden editor
  // So use ResizeSensor instead
  const containerRef = useRef<HTMLDivElement>();
  const resizeSensorRef = useRef<ResizeSensor>();
  function initializeResizeSensor(div: HTMLDivElement) {
    if (containerRef.current !== div) {
      if (resizeSensorRef.current) {
        resizeSensorRef.current.detach();
      }
      if (div) {
        resizeSensorRef.current = new ResizeSensor(div, () => {
          if (refEditor.current) refEditor.current.layout();
        });
      } else resizeSensorRef.current = null;
      containerRef.current = div;
    }
  }

  return (
    <div
      ref={initializeResizeSensor}
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
