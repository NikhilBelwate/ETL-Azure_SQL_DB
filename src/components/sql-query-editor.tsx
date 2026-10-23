"use client";

import { useEffect, useMemo, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { bracketMatching, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { acceptCompletion, autocompletion, closeBrackets, closeBracketsKeymap, closeCompletion, completionKeymap } from "@codemirror/autocomplete";
import { MSSQL, sql } from "@codemirror/lang-sql";
import { sqlCompletionSource } from "@/lib/sql-completion";
import type { TransferPlan } from "@/lib/transfer-types";

const sqlHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "light-dark(#6d28d9, #c4b5fd)", fontWeight: "500" },
  { tag: tags.string, color: "light-dark(#15803d, #86efac)" },
  { tag: tags.comment, color: "var(--muted-foreground)", fontStyle: "italic" },
  { tag: [tags.number, tags.bool, tags.null], color: "light-dark(#b45309, #fcd34d)" },
  { tag: [tags.typeName, tags.standard(tags.name)], color: "light-dark(#0369a1, #7dd3fc)" },
]);

const editorTheme = EditorView.theme({
  "&": { backgroundColor: "var(--muted)", color: "var(--foreground)", borderRadius: "0.375rem", fontSize: "0.875rem" },
  "&.cm-focused": { outline: "2px solid var(--primary)", outlineOffset: "2px" },
  ".cm-scroller": { fontFamily: "var(--font-geist-mono), Consolas, monospace", overflow: "auto", minHeight: "16rem", maxHeight: "30rem" },
  ".cm-content": { padding: "12px 0", caretColor: "var(--foreground)" },
  ".cm-line": { padding: "0 12px" },
  ".cm-gutters": { backgroundColor: "var(--muted)", color: "var(--muted-foreground)", borderColor: "var(--border)" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "color-mix(in srgb, var(--primary) 7%, transparent)" },
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "color-mix(in srgb, var(--primary) 25%, transparent)" },
  ".cm-tooltip": { backgroundColor: "var(--background)", color: "var(--foreground)", border: "1px solid var(--border)", borderRadius: "6px", boxShadow: "0 6px 20px #0003" },
  ".cm-tooltip-autocomplete > ul": { fontFamily: "inherit", maxWidth: "min(600px, 85vw)" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--primary)", color: "white" },
  ".cm-completionDetail": { marginLeft: "1rem", fontStyle: "normal", opacity: "0.8" },
});

export function SqlQueryEditor({ value, onChange, readOnly, plan }: {
  value: string; onChange: (value: string) => void; readOnly: boolean; plan: TransferPlan;
}) {
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const mode = useRef(new Compartment());
  const current = useRef({ value, onChange });
  const source = useMemo(() => sqlCompletionSource(plan), [plan.sourceName, plan.targetName, plan.sourceColumns, plan.targetColumns]);

  useEffect(() => { current.current = { value, onChange }; }, [value, onChange]);
  useEffect(() => {
    if (!container.current) return;
    const editor = new EditorView({ parent: container.current, state: EditorState.create({
      doc: current.current.value,
      extensions: [
        lineNumbers(), highlightSpecialChars(), history(), drawSelection(), bracketMatching(), closeBrackets(),
        highlightActiveLine(), highlightActiveLineGutter(), syntaxHighlighting(sqlHighlightStyle),
        sql({ dialect: MSSQL }),
        autocompletion({ override: [source], activateOnTyping: true, activateOnTypingDelay: 100 }),
        keymap.of([...completionKeymap, { key: "Tab", run: acceptCompletion }, ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap]),
        mode.current.of([]), editorTheme,
        EditorView.updateListener.of(update => { if (update.docChanged) current.current.onChange(update.state.doc.toString()); }),
      ],
    }) });
    view.current = editor;
    return () => { editor.destroy(); view.current = null; };
  }, [source]);
  useEffect(() => {
    const editor = view.current;
    if (editor && value !== editor.state.doc.toString()) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
  }, [value, source]);
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    editor.dispatch({ effects: mode.current.reconfigure([
      EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly),
      EditorView.contentAttributes.of({ id: "query-preview-editor", "aria-label": "Query preview editor", "aria-describedby": "query-preview-help query-editor-shortcuts query-verification-status", "aria-readonly": String(readOnly), spellcheck: "false", autocorrect: "off", autocapitalize: "off" }),
    ]) });
    if (readOnly) closeCompletion(editor);
    else editor.focus();
  }, [readOnly, source]);
  return <div ref={container} className="min-w-0 overflow-hidden rounded-md border border-border" />;
}
