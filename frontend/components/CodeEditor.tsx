"use client";

import React, { useMemo, useRef } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { python } from "@codemirror/lang-python";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
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

// Editor chrome and syntax colours come from the theme tokens (app/globals.css), so the editor
// follows the light/dark switch without re-creating any extension.
const c = (name: string, alpha = 1) => `rgb(var(--${name}) / ${alpha})`;

const tokenTheme = EditorView.theme({
  "&": { backgroundColor: "transparent", color: c("fg") },
  ".cm-content": { padding: "10px 0", caretColor: c("accent") },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: c("accent"), borderLeftWidth: "2px" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: c("accent", 0.28) },
  ".cm-gutters": { backgroundColor: "transparent", border: "none", color: c("muted", 0.75) },
  ".cm-activeLine": { backgroundColor: c("fg", 0.04) },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: c("fg") },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": { backgroundColor: c("accent", 0.22), outline: "none" },
  ".cm-placeholder": { color: c("muted") },
  ".cm-tooltip": { backgroundColor: c("elevated"), border: `1px solid ${c("line-strong")}`, color: c("fg"), borderRadius: "8px" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: c("accent", 0.25), color: c("fg") },
});

const tokenHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.moduleKeyword, t.definitionKeyword], color: c("syn-keyword") },
    { tag: [t.string, t.special(t.string), t.regexp], color: c("syn-string") },
    { tag: [t.number, t.bool, t.null, t.atom], color: c("syn-number") },
    { tag: [t.comment, t.lineComment, t.blockComment], color: c("syn-comment"), fontStyle: "italic" },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: c("syn-function"), fontWeight: "500" },
    { tag: [t.definition(t.variableName), t.className, t.definition(t.className)], color: c("syn-def") },
    { tag: [t.standard(t.variableName), t.self], color: c("syn-builtin") },
    { tag: [t.propertyName, t.attributeName], color: c("fg", 0.9) },
    { tag: [t.operator, t.punctuation, t.bracket], color: c("muted") },
    { tag: t.heading, color: c("fg"), fontWeight: "700" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.strong, fontWeight: "700" },
    { tag: t.link, color: c("syn-builtin"), textDecoration: "underline" },
  ]),
);

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
      tokenTheme,
      tokenHighlight,
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
        theme="none"
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
