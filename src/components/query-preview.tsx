"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { SqlQueryEditor } from "@/components/sql-query-editor";
import { useEtl, type DatabaseState } from "@/components/etl-provider";
import type { TransferPlan } from "@/lib/transfer-types";

const connectionDetails = (database: DatabaseState) => database.connectionMode === "string" ? { connectionString: database.connectionString } : database.connection;

export function QueryPreview({ query: generatedQuery, plan }: { query: string; plan: TransferPlan }) {
  const { databases, plan: savedPlan, setPlan } = useEtl();
  const savedQuery = savedPlan?.sourceName === plan.sourceName && savedPlan?.targetName === plan.targetName ? savedPlan.query : undefined;
  const accepted = useRef(savedQuery?.verificationId ? savedQuery : undefined);
  const [query, setQuery] = useState(savedQuery?.text ?? generatedQuery);
  const [editing, setEditing] = useState(!!savedQuery);
  const [verifying, setVerifying] = useState(false);
  const [verifiedQuery, setVerifiedQuery] = useState<string | null>(accepted.current?.text ?? null);
  const [result, setResult] = useState<{ success: boolean; message: string; warnings?: string[] } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const busy = useRef(false);

  useEffect(() => { if (result) dialog.current?.showModal(); }, [result]);

  async function verify() {
    if (busy.current) return;
    busy.current = true;
    setVerifying(true);
    setVerifiedQuery(null);
    setPlan({ ...plan, query: { text: query } });
    try {
      if (!query.trim()) throw new Error("Enter a query before verifying.");
      const response = await fetch("/api/transfer/verify-query", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, plan, sourceConnection: connectionDetails(databases.db1), targetConnection: connectionDetails(databases.db2) }),
      });
      let data;
      try { data = await response.json(); }
      catch { throw new Error("The server returned an invalid response. Please retry query verification."); }
      if (!response.ok) throw new Error(data.error || "Query validation failed. Review your SQL and try again.");
      if (!data.verificationId) throw new Error("Query verification could not be saved. Please retry.");
      accepted.current = { text: query, verificationId: data.verificationId };
      setPlan({ ...plan, query: accepted.current });
      setVerifiedQuery(query);
      setResult({ success: true, message: data.message, warnings: data.warnings });
    } catch (error) {
      setResult({ success: false, message: error instanceof Error ? error.message : "Unable to verify the query. Check your connection and retry." });
    } finally {
      busy.current = false;
      setVerifying(false);
    }
  }

  return <div className="space-y-4 rounded-xl border border-border p-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 className="font-semibold">Generated SQL</h3>
      {!editing && <Button onClick={() => setEditing(true)}>Edit Query</Button>}
    </div>
    <label htmlFor="query-preview-editor" className="block text-sm font-medium">Query preview editor</label>
    <SqlQueryEditor value={query} readOnly={!editing || verifying} plan={plan} onChange={value => {
      if (value === query) return;
      setQuery(value); setVerifiedQuery(null);
      setPlan({ ...plan, query: { text: value } });
    }} />
    <p id="query-editor-shortcuts" className="text-xs text-muted-foreground">SQL suggestions and keyword spelling corrections appear as you type. Press Ctrl+Space for suggestions, ↑/↓ to choose, Enter or Tab to accept, and Esc to dismiss. Corrections apply only when you select them.</p>
    <p id="query-preview-help" className="text-xs text-muted-foreground">Verify a standalone SELECT or keep both SELECT statements matching in the full preview. After successful verification, Data Load uses this SELECT's results, including filters and transformations. Further edits require verification again. Confirm Insert is still required to write records.</p>
    {editing && <div className="flex flex-wrap gap-3">
      <Button onClick={verify} disabled={verifying}>{verifying ? "Verifying Query..." : "Verify Query"}</Button>
      <Button disabled={verifying} onClick={() => {
        setQuery(accepted.current?.text ?? generatedQuery); setEditing(false); setVerifiedQuery(accepted.current?.text ?? null);
        setPlan({ ...plan, ...(accepted.current ? { query: accepted.current } : {}) });
      }}>Cancel Edits</Button>
    </div>}
    <p id="query-verification-status" role="status" className="text-sm text-muted-foreground">{verifying ? "Checking SQL syntax and logical compatibility..." : verifiedQuery === query ? "Query verified successfully." : editing ? "Click Verify Query to validate your changes." : "Click Edit Query to enable typing."}</p>
    {savedPlan?.query && !savedPlan.query.verificationId || verifying ? <p className="text-sm text-amber-700 dark:text-amber-300">Verify the edited query successfully before continuing to Data Load.</p> : <Link href="/loading" className="inline-block text-primary underline">Continue to Data Load →</Link>}
    <dialog ref={dialog} aria-labelledby="query-validation-title" aria-describedby="query-validation-message"
      onClose={() => setResult(null)} className="fixed inset-0 m-auto max-h-[80vh] w-[calc(100%-2rem)] max-w-xl overflow-y-auto rounded-xl border border-border bg-background p-6 text-foreground shadow-xl backdrop:bg-black/50">
      {result && <div className="space-y-4">
        <h3 id="query-validation-title" className={`text-lg font-semibold ${result.success ? "text-green-700 dark:text-green-300" : "text-red-700 dark:text-red-300"}`}>{result.success ? "Query validation successful" : "Query validation failed"}</h3>
        <p id="query-validation-message" className="whitespace-pre-wrap break-words text-sm">{result.message}</p>
        {!!result.warnings?.length && <div className="text-sm"><p className="font-semibold">Conversion warnings to review</p><ul className="mt-2 list-disc space-y-2 pl-5">{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
        <Button onClick={() => dialog.current?.close()}>Close</Button>
      </div>}
    </dialog>
  </div>;
}
