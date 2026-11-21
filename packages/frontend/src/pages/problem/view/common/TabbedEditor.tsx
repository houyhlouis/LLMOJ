import React, { useEffect, useRef, useState } from "react";
import { Menu } from "semantic-ui-react";
import { observer } from "mobx-react";
import type * as Monaco from "monaco-editor";

import style from "./TabbedEditor.module.less";

import { useLocalizer } from "@/utils/hooks";
import CodeEditor from "@/components/LazyCodeEditor";
import HorizontalScroll from "@/components/HorizontalScroll";
import { EmojiRenderer } from "@/components/EmojiRenderer";
import { actsAsButton } from "@/utils/keyboard";

interface TabbedEditorTab {
  title: string;
  icon: string;
  language: string;
  initialContent: string;
}

interface TabbedEditorProps {
  tabs: TabbedEditorTab[];
  refSetValue?: React.MutableRefObject<(tabIndex: number, value: string) => void>;
  onChange: (tabIndex: number, value: string) => void;
}

let TabbedEditor: React.FC<TabbedEditorProps> = props => {
  const _ = useLocalizer("problem");

  // Without a ref wrapper, props.onChange() will call the outdated old callback function
  // which is binded with the outdated states of the parent component
  const refOnChangeCallback = useRef<typeof props.onChange>();
  refOnChangeCallback.current = props.onChange;

  // The tabs' models and their change listeners belong to this component: it disposes them all when it unmounts or
  // its editor is mounted again (the editor wrapper disposes only the model attached to the editor)
  const refTabStates = useRef<
    {
      model: Monaco.editor.ITextModel;
      viewState: Monaco.editor.ICodeEditorViewState;
      subscription: Monaco.IDisposable;
    }[]
  >(null);

  if (props.refSetValue)
    props.refSetValue.current = (tabIndex: number, value: string) => {
      if (refTabStates.current) refTabStates.current[tabIndex].model.setValue(value);
    };

  const refEditor = useRef<Monaco.editor.IStandaloneCodeEditor>();

  const [currentTabIndex, setCurrentTabIndex] = useState(0);
  const refCurrentTabIndex = useRef(currentTabIndex);
  refCurrentTabIndex.current = currentTabIndex;

  function disposeTabs() {
    const tabs = refTabStates.current;
    refTabStates.current = null;
    if (!tabs) return;
    const editor = refEditor.current;
    try {
      // Detach ours first, so that the wrapper doesn't dispose it a second time
      if (editor && tabs.some(tab => tab.model === editor.getModel())) editor.setModel(null);
    } catch {
      // The editor was disposed already, with its model
    }
    for (const tab of tabs) {
      tab.subscription.dispose();
      if (!tab.model.isDisposed()) tab.model.dispose();
    }
  }
  useEffect(() => disposeTabs, []);

  function editorDidMount(editor: Monaco.editor.IStandaloneCodeEditor) {
    disposeTabs();
    const initialModel = editor.getModel();
    refTabStates.current = props.tabs.map((tab, i) => {
      const model = (window["Monaco"] as typeof Monaco).editor.createModel(tab.initialContent, tab.language);
      const subscription = model.onDidChangeContent(() => refOnChangeCallback.current(i, model.getValue()));
      return {
        model,
        viewState: null,
        subscription
      };
    });
    refEditor.current = editor;
    editor.setModel(refTabStates.current[refCurrentTabIndex.current]?.model);
    // The empty model the wrapper created is attached to nothing now
    if (initialModel && initialModel !== editor.getModel() && !initialModel.isDisposed()) initialModel.dispose();
  }

  function onChangeTab(index: number) {
    if (index === currentTabIndex) return;

    if (refEditor.current) {
      refTabStates.current[currentTabIndex].viewState = refEditor.current.saveViewState();
      refEditor.current.setModel(refTabStates.current[index].model);
      refEditor.current.restoreViewState(refTabStates.current[index].viewState);
    }

    setCurrentTabIndex(index);
  }

  return (
    <div className={style.tabbedEditor}>
      <HorizontalScroll className={style.tabMenuContainer}>
        <Menu secondary className={style.tabMenu}>
          {props.tabs.map((tab, i) => (
            <EmojiRenderer key={i}>
              <Menu.Item
                {...actsAsButton}
                active={currentTabIndex === i}
                icon={tab.icon}
                content={tab.title}
                onClick={() => onChangeTab(i)}
              />
            </EmojiRenderer>
          ))}
        </Menu>
      </HorizontalScroll>
      <div className={style.wrapper}>
        <CodeEditor editorDidMount={editorDidMount} value={null} language={null} />
      </div>
    </div>
  );
};

TabbedEditor = observer(TabbedEditor);

export default TabbedEditor;
