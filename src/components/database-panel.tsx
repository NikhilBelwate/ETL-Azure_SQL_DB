"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useEtl, type DbId } from "@/components/etl-provider";
import type { DbConnection, TableInfo } from "@/lib/azureSql";
export function DatabasePanel({ id }: { id: DbId }) {
  const { databases, updateDatabase } = useEtl();
  const db = databases[id];
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const fields: [keyof DbConnection, string, string][] = [["server", "Server", "server.database.windows.net"], ["database", "Database", "Database name"], ["userName", "Username", "SQL username"], ["password", "Password", "SQL password"]];
  async function loadTables(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setLoading(true); setError("");
    try {
      const payload = db.connectionMode === "string" ? { connectionString: db.connectionString.trim() } : db.connection;
      const response = await fetch(`/api/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data: { tables?: TableInfo[]; error?: string } = await response.json();
      if (!response.ok || !Array.isArray(data.tables)) throw new Error(data.error || "Unable to load tables. Please try again.");
      const tables = data.tables;
      updateDatabase(id, previous => ({ ...previous, tables, selectedTable: tables[0]?.name || "" }));
      if (!tables.length) setError("Connected, but this database has no tables.");
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to load tables."); }
    finally { setLoading(false); }
  }
  return <section aria-labelledby={`${id}-heading`} className="min-w-0 rounded-xl border border-border p-6">
    <h2 id={`${id}-heading`} className="mb-4 text-lg font-semibold">{id === "db1" ? "Database 1 · Source" : "Database 2 · Target"}</h2>
    <form onSubmit={loadTables} className="space-y-4">
      <fieldset disabled={loading} className="space-y-2">
        <legend className="mb-2 text-sm font-medium">Connection method</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          {([["string", "Connection string"], ["fields", "Individual fields"]] as const).map(([mode, label]) => (
            <label key={mode} className="flex items-center gap-2">
              <input type="radio" name={`${id}-connection-mode`} value={mode} checked={db.connectionMode === mode}
                onChange={() => { setError(""); updateDatabase(id, previous => ({ ...previous, connectionMode: mode, tables: [], selectedTable: "" })); }} />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      {db.connectionMode === "string" ? <div>
        <label htmlFor={`${id}-connection-string`} className="mb-1 block text-sm font-medium">Full connection string</label>
        <textarea id={`${id}-connection-string`} required disabled={loading} rows={5} autoComplete="off" spellCheck={false}
          aria-describedby={`${id}-connection-string-help`} value={db.connectionString}
          placeholder="Server=tcp:server.database.windows.net,1433;Initial Catalog=database;User ID=username;Password=password;Encrypt=True;TrustServerCertificate=False;"
          className="block w-full min-w-0 resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-sm placeholder:text-muted-foreground focus:ring-2 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
          onChange={event => { setError(""); updateDatabase(id, previous => ({ ...previous, connectionString: event.target.value, tables: [], selectedTable: "" })); }} />
        <p id={`${id}-connection-string-help`} className="mt-2 text-sm text-muted-foreground">Paste your Azure SQL connection string, including the database, username, and password.</p>
      </div> : <fieldset disabled={loading} className="grid gap-4 sm:grid-cols-2">
        {fields.map(([field, title, placeholder]) => <div key={field}>
          <label htmlFor={`${id}-${field}`} className="mb-1 block text-sm font-medium">{title}</label>
          <Input id={`${id}-${field}`} required type={field === "password" ? "password" : "text"} autoComplete={field === "password" ? "off" : undefined} placeholder={placeholder} value={String(db.connection[field] || "")}
            onChange={event => updateDatabase(id, previous => ({ ...previous, tables: [], selectedTable: "", connection: { ...previous.connection, [field]: event.target.value } }))} />
        </div>)}
      </fieldset>}
      <Button type="submit" disabled={loading}>{loading ? "Connecting..." : `Load Tables ${id.toUpperCase()}`}</Button>
      {loading && <p role="status" className="text-sm text-muted-foreground">Fetching tables...</p>}
      {error && <p role="alert" className="rounded-md bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
    </form>
    {db.tables.length > 0 && <div className="mt-5 space-y-2">
      <label htmlFor={`${id}-table`} className="block text-sm font-medium">Select Table from {id.toUpperCase()}</label>
      <Select id={`${id}-table`} value={db.selectedTable} disabled={loading} onValueChange={selectedTable => updateDatabase(id, previous => ({ ...previous, selectedTable }))} options={db.tables.map(table => ({ value: table.name, label: table.name }))} />
      <p className="text-sm text-muted-foreground">{db.tables.length} tables available</p>
    </div>}
  </section>;
}
