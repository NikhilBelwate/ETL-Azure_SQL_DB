"use client";

import { useEffect, useRef, useState } from "react";
import type { TransferProgress } from "@/lib/transfer-types";

export interface ConsoleEntry extends TransferProgress { id: number; time: string; elapsed: number; }
export function TransferConsole({ entries, active, elapsed }: {entries: ConsoleEntry[]; active: boolean; elapsed: number}) {
  const [level,setLevel] = useState("all"), [search,setSearch] = useState(""), [follow,setFollow] = useState(true);
  const viewport = useRef<HTMLDivElement>(null);
  const visible = entries.filter(entry => (level === "all" || entry.level === level) && `${entry.stage} ${entry.message}`.toLowerCase().includes(search.toLowerCase()));
  useEffect(() => { if (follow && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight; },[entries,follow,level,search]);
  const colors = {info:"text-slate-300",success:"text-emerald-300",warning:"text-amber-300",error:"text-rose-300"};
  function download() {
    const text = entries.map(entry=>`${entry.time} +${(entry.elapsed/1000).toFixed(1)}s ${entry.level.toUpperCase()} [${entry.stage}] ${entry.message}`).join("\n");
    const url = URL.createObjectURL(new Blob([text],{type:"text/plain;charset=utf-8"}));
    const link = document.createElement("a"); link.href=url; link.download="etl-transfer-log.txt"; link.click(); URL.revokeObjectURL(url);
  }
  return <section aria-label="Transfer console" className="overflow-hidden rounded-xl border border-slate-700 bg-slate-950 text-slate-200 shadow-xl">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-700 bg-slate-900 px-5 py-4">
      <div className="flex flex-wrap items-center gap-3"><span aria-hidden="true" className={`h-2 w-2 rounded-full ${active ? "animate-pulse bg-sky-400" : "bg-slate-500"}`} /><h2 className="font-semibold">Transfer console</h2><span className="font-mono text-xs text-slate-400">{active ? "LIVE" : "IDLE"} · operation {(elapsed/1000).toFixed(1)}s</span></div>
      <button type="button" onClick={download} disabled={!entries.length} className="rounded border border-slate-600 px-3 py-1.5 text-xs hover:bg-slate-800 disabled:opacity-40">Download logs</button>
    </div>
    <div className="flex flex-wrap items-center gap-3 border-b border-slate-800 px-5 py-3 text-xs">
      <label className="flex items-center gap-2">Level<select aria-label="Log level" value={level} onChange={event=>setLevel(event.target.value)} className="rounded border border-slate-600 bg-slate-900 p-2"><option value="all">All levels</option>{["info","success","warning","error"].map(value=><option key={value} value={value}>{value.toUpperCase()}</option>)}</select></label>
      <input aria-label="Search logs" placeholder="Search stage or message…" value={search} onChange={event=>setSearch(event.target.value)} className="min-w-40 flex-1 rounded border border-slate-600 bg-slate-900 p-2 placeholder:text-slate-500" />
      <label className="flex items-center gap-2"><input type="checkbox" checked={follow} onChange={event=>setFollow(event.target.checked)}/>Auto-scroll</label>
      <span className="text-slate-400">{visible.length} / {entries.length} entries</span>
    </div>
    <div ref={viewport} role="log" aria-label="Transfer activity log" aria-live="polite" aria-relevant="additions" tabIndex={0} className="h-96 overflow-auto p-4 font-mono text-xs leading-6 md:text-sm">
      {!entries.length ? <p className="text-slate-500">Waiting for a transfer. Start Data Load to stream server activity here.</p> : !visible.length ? <p className="text-slate-500">No logs match this filter.</p> : visible.map(entry=><div key={entry.id} className={`grid grid-cols-[auto_1fr] gap-x-3 border-l-2 py-1 pl-3 ${entry.level === "error" ? "border-rose-500 bg-rose-500/5" : entry.level === "warning" ? "border-amber-500/60" : "border-slate-800"}`}>
        <span className="text-[11px] text-slate-500">{entry.time.slice(11,23)}<br/>+{(entry.elapsed/1000).toFixed(1)}s</span>
        <div className="min-w-0"><span className={`mr-2 text-xs font-bold ${colors[entry.level]}`}>{entry.level.toUpperCase()}</span><span className="text-sky-300">[{entry.stage}]</span><p className={`whitespace-pre-wrap break-words ${colors[entry.level]}`}>{entry.message}</p></div>
      </div>)}
    </div>
    <p className="border-t border-slate-800 px-5 py-3 text-xs text-slate-500">UTC timestamps · latest 500 entries · retained while this page is open · row ranges refer to the current batch</p>
  </section>;
}
