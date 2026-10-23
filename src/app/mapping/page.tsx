"use client";

import { DatabasePanel } from "@/components/database-panel";
import { ColumnMappings } from "@/components/column-mappings";
import { useEtl } from "@/components/etl-provider";

export default function MappingPage() {
  const { databases } = useEtl();
  const source = databases.db1.tables.find(table => table.name === databases.db1.selectedTable);
  const target = databases.db2.tables.find(table => table.name === databases.db2.selectedTable);
  // Revalidate from a clean state when either selected table schema changes.
  const key = JSON.stringify([source, target]);
  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6 md:p-10">
      <div><h1 className="text-3xl font-semibold">Column Mapping</h1><p className="mt-2 text-muted-foreground">Select tables, choose compatible target columns, and preview transformations.</p></div>
      <div className="grid gap-6 lg:grid-cols-2"><DatabasePanel id="db1" /><DatabasePanel id="db2" /></div>
      {source && target ? <ColumnMappings key={key} sourceName={source.name} targetName={target.name} sourceColumns={source.columns} targetColumns={target.columns} /> : <div className="rounded-xl border border-dashed border-border p-8 text-center"><h2 className="font-semibold">Choose your source and target tables</h2><p className="mt-2 text-sm text-muted-foreground">Load tables from both databases to begin mapping columns. Connections stay available as you navigate.</p></div>}
    </div>
  );
}
