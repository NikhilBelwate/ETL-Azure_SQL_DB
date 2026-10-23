"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RecordsTable } from "@/components/records-table";
import { useEtl, type DatabaseState } from "@/components/etl-provider";
import type { InsertResult, PreviewResult, TransferProgress } from "@/lib/transfer-types";
import { readTransferResponse, TransferRequestError } from "@/lib/transfer-client";
import { TransferConsole, type ConsoleEntry } from "@/components/transfer-console";

const connectionDetails = (database: DatabaseState) => database.connectionMode === "string" ? { connectionString: database.connectionString } : database.connection;

export function DataLoading({ request = fetch }: { request?: typeof fetch }) {
  const { databases, plan } = useEtl();
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [result, setResult] = useState<InsertResult | null>(null);
  const [status, setStatus] = useState<"idle" | "fetching" | "ready" | "inserting" | "completed" | "insert-error">("idle");
  const [error, setError] = useState("");
  const [batchSize, setBatchSize] = useState(1000);
  const [insertedTotal, setInsertedTotal] = useState(0);
  const [skippedTotal, setSkippedTotal] = useState(0);
  const [entries,setEntries] = useState<ConsoleEntry[]>([]);
  const [work,setWork] = useState<TransferProgress | null>(null);
  const [elapsed,setElapsed] = useState(0);
  const sequence = useRef(0), runStarted = useRef(0), operationStarted = useRef(0);
  const lastStage = useRef("idle");
  const busy = useRef(false);
  const [confirmedPlan, setConfirmedPlan] = useState<typeof plan>(null);
  const currentPreview = preview && confirmedPlan === plan;
  const pending = status === "fetching" || status === "inserting";
  const needsVerification = !!plan?.query && !plan.query.verificationId;

  const validBatchSize = Number.isInteger(batchSize) && batchSize >= 1 && batchSize <= 1000;
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(()=>setElapsed(Date.now()-operationStarted.current),250);
    return () => clearInterval(timer);
  },[pending]);

  function log(event: TransferProgress) {
    if (!runStarted.current) runStarted.current = Date.now();
    const entry = {...event,id:++sequence.current,time:new Date().toISOString(),elapsed:Date.now()-runStarted.current};
    setEntries(previous=>[...previous,entry].slice(-500));
  }
  function receiveProgress(event: TransferProgress) {
    lastStage.current = event.stage;
    setWork(event); log(event);
  }
  function beginOperation(stage: string, message: string) {
    operationStarted.current = Date.now(); setElapsed(0);
    receiveProgress({stage,message,level:"info"});
  }
  function showFailure(error: unknown, inserting = false) {
    const failure = error instanceof TransferRequestError ? error.failure : null;
    const message = error instanceof Error ? error.message : "The transfer request failed.";
    const stage = failure?.stage ?? lastStage.current;
    const details = failure?.details;
    const diagnostics = details ? Object.entries(details).filter(([,value])=>value !== undefined && value !== "").map(([key,value])=>`${key}: ${value}`).join("\n") : "";
    const uncertainty = !failure && inserting ? "\nThe response was interrupted. The insert outcome is unknown. Check the target table before starting another load." : "";
    setError(`${message}${uncertainty}`);
    receiveProgress({stage,level:"error",message:`${message}${diagnostics ? `\n${diagnostics}` : ""}${uncertainty}`});
  }

  async function startDataLoad(nextBatch = false, skipCurrent = false) {
    if (!plan || needsVerification || !validBatchSize || busy.current || nextBatch && (!currentPreview || !preview.canContinue)) return;
    const previousStatus = status;
    busy.current = true;
    setStatus("fetching"); setError("");
    beginOperation("request-fetch",nextBatch ? `Requesting batch ${preview.batchNumber+1}${skipCurrent ? "; current batch will be skipped only after the next preview succeeds" : ""}.` : `Starting transfer: ${plan.sourceName} → ${plan.targetName}. Batch size ${batchSize}.`);
    try {
      const response = await request("/api/transfer/preview", { method: "POST", headers: { "Content-Type": "application/json",Accept:"application/x-ndjson" }, body: JSON.stringify({ sourceConnection: connectionDetails(databases.db1), targetConnection: connectionDetails(databases.db2), plan, batchSize, ...(nextBatch ? { previousPreviewId: preview.previewId, skipCurrent } : {}) }) });
      const data = await readTransferResponse<PreviewResult>(response,receiveProgress);
      if (nextBatch && skipCurrent) {
        setSkippedTotal(total=>total+preview.sourceRows.length);
        log({stage:"skip-batch",level:"warning",message:`Skipped batch ${preview.batchNumber}: ${preview.sourceRows.length} records were not inserted.`});
      }
      setPreview(data); setResult(null); setConfirmedPlan(plan); setStatus("ready");
      receiveProgress({stage:"awaiting-review",level:"success",message:`Batch ${data.batchNumber} ready: ${data.sourceRows.length} records. ${data.hasMore ? "More source records remain; the total is not counted." : "End of source results reached."} ${data.sourceRows.length ? "Review the records, then confirm insertion." : "No records to insert."}`});
      if (data.batchMessage) log({stage:"continuation",level:"warning",message:data.batchMessage});
      if (!nextBatch) { setInsertedTotal(0); setSkippedTotal(0); }
    } catch (error) { showFailure(error); setStatus(previousStatus); }
    finally { setElapsed(Date.now()-operationStarted.current); busy.current = false; }
  }

  async function confirmInsert() {
    if (!currentPreview || !preview.sourceRows.length || busy.current || status !== "ready") return;
    busy.current = true;
    setStatus("inserting"); setError("");
    beginOperation("request-insert",`Confirming batch ${preview.batchNumber}: ${preview.sourceRows.length} reviewed records for ${plan.targetName}.`);
    try {
      const response = await request("/api/transfer/insert", { method: "POST", headers: { "Content-Type": "application/json",Accept:"application/x-ndjson" }, body: JSON.stringify({ previewId: preview.previewId }) });
      const data = await readTransferResponse<InsertResult>(response,receiveProgress);
      setResult(data); setInsertedTotal(total=>total+data.count); setStatus("completed");
      receiveProgress({stage:"completed",level:"success",processed:data.count,total:preview.sourceRows.length,message:`Batch ${preview.batchNumber} completed: ${data.count} committed. ${preview.hasMore ? "Load the next batch to continue." : "Final batch completed."}`});
    } catch (error) { showFailure(error,true); setStatus("insert-error"); }
    finally { setElapsed(Date.now()-operationStarted.current); busy.current = false; }
  }

  const batchRecords = currentPreview ? preview.sourceRows.length : 0;
  const batchCommitted = currentPreview && status === "completed" ? result?.count ?? 0 : 0;
  const processed = status === "inserting" ? work?.processed ?? 0 : batchCommitted;
  const percent = batchRecords ? Math.min(100,Math.round(processed/batchRecords*100)) : 0;

  return <div className="mx-auto max-w-7xl space-y-6 p-6 md:p-10">
    <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">Transfer workspace</p><h1 className="text-3xl font-semibold">Data Loading</h1><p className="mt-2 text-muted-foreground">Follow each processing stage live, review a batch, and track its transaction through completion.</p></div><span className={`rounded-full border px-3 py-1 text-xs font-medium ${error ? "border-red-500/40 text-red-500" : pending ? "border-sky-500/40 text-sky-500" : "border-border text-muted-foreground"}`}>{error ? "Needs attention" : pending ? "Processing" : status === "completed" ? "Batch completed" : "Ready"}</span></div>
    {!plan ? <div className="rounded-xl border border-border p-6"><h2 className="font-semibold">Prepare your column mappings first</h2><p className="mt-2 text-muted-foreground">Connect both databases, select tables, and generate a valid query preview in Mapping.</p><Link href="/mapping" className="mt-4 inline-block text-primary underline">Go to Mapping →</Link></div> : <>
      <div className="grid items-start gap-6 xl:grid-cols-[300px_minmax(0,1fr)]">
      <section className="space-y-4 rounded-xl border border-border p-5" aria-label="Data load controls">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Batch controls</h2>
        <p className="break-words font-medium">{plan.sourceName} → {plan.targetName}</p>
        <p className="text-xs text-muted-foreground">Fetch, review, then confirm each batch. Up to 1,000 records per batch; previews expire after 15 minutes.</p>
        <div className="max-w-xs space-y-2"><label htmlFor="batch-size" className="block text-sm font-medium">Records per batch</label><Input id="batch-size" type="number" min={1} max={1000} step={1} value={batchSize} disabled={pending || !!currentPreview} onChange={event=>setBatchSize(Number(event.target.value))} aria-describedby="batch-help" aria-invalid={!validBatchSize}/></div>
        <p id="batch-help" className="text-xs text-muted-foreground">Choose 1-1,000; use fewer for large values. Keep source data stable during transfer. Each new batch replaces the previous preview.</p>
        {plan.query && <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{needsVerification ? "The query was modified after verification. Return to Mapping and verify it before fetching records." : "Source Records will contain the results of your successfully verified SELECT, including its filters and transformations."}</p>
          <details className="rounded-md border border-border p-3"><summary className="cursor-pointer text-sm font-medium">{needsVerification ? "Query awaiting verification" : "Verified query from Mapping"}</summary><pre className="mt-3 overflow-x-auto rounded-md bg-muted p-4 text-sm"><code>{plan.query.text}</code></pre></details>
        </div>}
        <div className="flex flex-col gap-3">
          <Button onClick={()=>startDataLoad()} disabled={!validBatchSize || needsVerification || pending || !!currentPreview}>{status === "fetching" ? "Fetching Source Records..." : "Start Data Load"}</Button>
          <Button onClick={confirmInsert} disabled={!currentPreview || !preview?.sourceRows.length || status !== "ready"}>{status === "inserting" ? "Inserting Records..." : "Confirm Insert"}</Button>
          {currentPreview && preview.canContinue && status === "completed" && <Button onClick={()=>startDataLoad(true)} disabled={pending}>Load Next Batch</Button>}
          {currentPreview && preview.canContinue && status === "ready" && <Button onClick={()=>startDataLoad(true,true)} disabled={pending}>Skip This Batch &amp; Load Next</Button>}
        </div>
        {currentPreview && <p className="text-sm font-medium">Batch {preview.batchNumber} · {preview.sourceRows.length} records · {insertedTotal} records inserted this run{preview.hasMore ? " · more records available" : " · final batch"}</p>}
        {currentPreview && preview.batchMessage && <p role="alert" className="rounded-md bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">{preview.batchMessage}</p>}
        {currentPreview && status === "ready" && preview.canContinue && <p className="text-xs text-muted-foreground">Skipping discards this batch without inserting it. Use Confirm Insert first if you want these records transferred.</p>}
        <p role="status" className="text-sm text-muted-foreground">{status === "fetching" ? "Reading source records and applying the mapped transformations..." : status === "inserting" ? "Inserting the reviewed batch. Keep this page open until the result is shown." : status === "completed" ? `${result?.count || 0} records inserted into ${plan.targetName}.` : status === "insert-error" ? "The insert did not complete successfully. Review the error before starting another load." : currentPreview ? `${preview.sourceRows.length} source records fetched. ${preview.sourceRows.length ? "Review the source and mapped values before confirming." : "There are no records to insert."}` : "Ready to fetch source records."}</p>
        {error && <div role="alert" className="rounded-md border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-600 dark:text-red-400">{error}</div>}
      </section>
      <div className="min-w-0 space-y-4">
      <section aria-label="Transfer progress" className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[
          ["Current batch",currentPreview ? `#${preview.batchNumber} · ${batchRecords} rows` : "Not fetched"],
          ["Committed this run",currentPreview ? insertedTotal.toLocaleString() : "0"],
          ["Batch pending commit",Math.max(0,batchRecords-batchCommitted).toLocaleString()],
          ["Skipped this run",currentPreview ? skippedTotal.toLocaleString() : "0"],
        ].map(([label,value])=><div key={label} className="rounded-xl border border-border bg-muted/20 p-4"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-2 text-xl font-semibold tabular-nums">{value}</p></div>)}</div>
        <div className="rounded-xl border border-border p-4">
          <div className="flex flex-wrap justify-between gap-2 text-sm"><span>Stage: <strong className="font-mono">{work?.stage ?? "idle"}</strong></span><span className="tabular-nums">{processed} / {batchRecords} batch rows processed{batchRecords ? ` · ${percent}%` : ""}</span></div>
          <div role="progressbar" aria-label="Current batch processing" aria-valuemin={0} aria-valuemax={100} {...(status !== "fetching" ? {"aria-valuenow":percent} : {})} aria-valuetext={status === "fetching" ? "Fetching; record count not available yet" : `${percent}% processed; ${batchCommitted} committed`} className="mt-3 h-2 overflow-hidden rounded-full bg-muted"><div className={`h-full rounded-full transition-all ${error ? "bg-red-500" : status === "completed" ? "bg-emerald-500" : "bg-sky-500"} ${status === "fetching" ? "w-1/3 animate-pulse" : ""}`} style={status === "fetching" ? undefined : {width:`${percent}%`}}/></div>
          <p className="mt-2 text-xs text-muted-foreground">{status === "inserting" ? "Processed rows are provisional until the transaction commits. " : ""}{currentPreview ? preview.hasMore ? "Additional source records remain; total pending is unknown (no full-table count)." : "No additional source records remain after this batch." : "Source totals are discovered in batches."} Pending commit includes failed or unconfirmed rows; it does not mean they are safe to retry.</p>
        </div>
      </section>
      <TransferConsole entries={entries} active={pending} elapsed={elapsed}/>
      </div>
      </div>
      {currentPreview && <>
        <div className="border-t border-border pt-6"><h2 className="text-xl font-semibold">Review current batch</h2><p className="mt-1 text-sm text-muted-foreground">Source, mapped, and committed target records for this batch.</p></div>
        <RecordsTable key={`${preview.previewId}-source`} title={`Source Records · ${preview.sourceName}`} columns={preview.sourceColumns} rows={preview.sourceRows} />
        <RecordsTable key={`${preview.previewId}-mapped`} title="Mapped Records to Insert" columns={preview.targetColumns} rows={preview.mappedRows} />
        {result && <RecordsTable key={`${preview.previewId}-inserted`} title={`Inserted Target Records · ${preview.targetName}`} columns={result.columns} rows={result.insertedRows} />}
        <details className="rounded-xl border border-border p-4"><summary className="cursor-pointer text-sm font-medium">Executed source SELECT</summary><pre className="mt-3 overflow-x-auto rounded-md bg-muted p-4 text-sm"><code>{preview.selectQuery}</code></pre></details>
      </>}
    </>}
    <Link href="/mapping" className="inline-block text-primary underline">Back to Mapping</Link>
  </div>;
}
