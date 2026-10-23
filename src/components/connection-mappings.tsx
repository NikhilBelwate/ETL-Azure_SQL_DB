"use client";

import { ColumnMappings } from "@/components/column-mappings";
import { useEtl } from "@/components/etl-provider";
import { sameTableName } from "@/lib/automatic-mappings";

export function ConnectionMappings() {
  const { databases } = useEtl();
  const source = databases.db1.tables.find(table => table.name === databases.db1.selectedTable);
  const target = databases.db2.tables.find(table => table.name === databases.db2.selectedTable);
  if (!source || !target || !sameTableName(source.name, target.name)) return null;
  return <ColumnMappings key={JSON.stringify([source,target])} sourceName={source.name} targetName={target.name} sourceColumns={source.columns} targetColumns={target.columns} />;
}
