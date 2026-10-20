// What modules that import "monaco-editor" get (see vite.config.ts): the editor @monaco-editor/react loaded from the
// site's own copy, before any such module is imported (see components/LazyCodeEditor.tsx). Types still come from the
// package.
import type * as MonacoTypes from "monaco-editor";

const monaco = (window as unknown as { Monaco: typeof MonacoTypes }).Monaco;

export const { editor, languages, KeyCode, KeyMod, Range, Selection, Position, Uri, MarkerSeverity } = monaco;
export default monaco;
