"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { DisplayRow } from "@/lib/transfer-types";

function displayValue(value: unknown) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
export function RecordsTable({ title, columns, rows }: { title: string; columns: string[]; rows: DisplayRow[] }) {
  const [page, setPage] = useState(0);
  const pageSize = 25, pages = Math.max(1, Math.ceil(rows.length / pageSize)), current = Math.min(page, pages - 1);
  return <section className="min-w-0 space-y-3 rounded-xl border border-border p-5" aria-label={title}>
    <h2 className="text-xl font-semibold">{title}</h2>
    <p className="text-sm text-muted-foreground">{rows.length} records{rows.length > pageSize ? ` · page ${current + 1} of ${pages}` : ""}</p>
    {rows.length ? <div className="max-h-[32rem] overflow-auto rounded-md border border-border"><table className="w-full border-collapse text-left text-sm"><caption className="sr-only">{title}</caption><thead className="sticky top-0 bg-muted"><tr>{columns.map(column => <th key={column} scope="col" className="whitespace-nowrap border-b border-border px-4 py-3">{column}</th>)}</tr></thead><tbody>{rows.slice(current * pageSize, (current + 1) * pageSize).map((row, index) => <tr key={current * pageSize + index} className="even:bg-muted/40">{columns.map(column => <td key={column} className="max-w-sm whitespace-pre-wrap break-words border-b border-border px-4 py-3">{displayValue(row[column])}</td>)}</tr>)}</tbody></table></div> : <p className="text-muted-foreground">No records returned.</p>}
    {pages > 1 && <div className="flex gap-3"><Button disabled={current === 0} onClick={() => setPage(current - 1)}>Previous</Button><Button disabled={current === pages - 1} onClick={() => setPage(current + 1)}>Next</Button></div>}
  </section>;
}
