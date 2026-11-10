"use client";

import React, { useMemo, useRef } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { python } from "@codemirror/lang-python";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, keymap } from "@codemirror/view";
import { Prec } from "@codemirror/state";

export interface EditorKeys {
  onRun?: () => void;            // Ctrl/Cmd+Enter
  onRunAdvance?: () => void;     // Shift+Enter
  onRunInsert?: () => void;      // Alt+Enter
  onEscape?: () => void;
}

interface Props extends EditorKeys {
  value: string;
  onChange: (v: string) => void;
  language?: "python" | "markdown";
  autoFocus?: boolean;
  onFocus?: () => void;
  minHeight?: string;
  placeholder?: string;
}

const transparentTheme = EditorView.theme({
  "&": { backgroundColor: "transparent" },
  ".cm-content": { padding: "10px 0" },
});

export default function CodeEditor({ value, onChange, language = "python", autoFocus, onFocus, minHeight, placeholder, ...keys }: Props) {
  // Latest handlers live in a ref so the keymap extension is created once.
  const keysRef = useRef<EditorKeys>(keys);
  keysRef.current = keys;

  const extensions = useMemo(() => {
    const run = (k: keyof EditorKeys) => () => {
      const fn = keysRef.current[k];
      if (!fn) return false;
      fn();
      return true;
    };
    const exts = [
      transparentTheme,
      EditorView.lineWrapping,
      Prec.highest(
        keymap.of([
          { key: "Shift-Enter", run: run("onRunAdvance") },
          { key: "Mod-Enter", run: run("onRun") },
          { key: "Alt-Enter", run: run("onRunInsert") },
          { key: "Escape", run: run("onEscape") },
        ])
      ),
    ];
    if (language === "python") exts.push(python());
    return exts;
  }, [language]);

  return (
    <div className="cell-editor" onFocus={onFocus}>
      <CodeMirror
        value={value}
        onChange={onChange}
        theme={oneDark}
        extensions={extensions}
        autoFocus={autoFocus}
        placeholder={placeholder}
        minHeight={minHeight}
        basicSetup={{
          lineNumbers: language === "python",
          foldGutter: false,
          highlightActiveLine: true,
          highlightActiveLineGutter: true,
          autocompletion: true,
          bracketMatching: true,
          closeBrackets: true,
          indentOnInput: true,
          tabSize: 4,
        }}
        indentWithTab
      />
    </div>
  );
}
