import type { ColumnInfo } from "./azureSql";
import type { ColumnMappingValues } from "./mapping-validation";

// Connections and schemas may differ; compare the actual table names exactly.
export function sameTableName(sourceName: string, targetName: string): boolean {
  const source = sourceName.split(".").at(-1);
  const target = targetName.split(".").at(-1);
  return !!source && !!target && source === target;
}

export function automaticColumnMappings(sourceName: string, targetName: string, sourceColumns: ColumnInfo[], targetColumns: ColumnInfo[]): ColumnMappingValues {
  if (!sameTableName(sourceName, targetName)) return {};
  const targetNames = new Set(targetColumns.map(column => column.name));
  // Map by name, then let the existing validator report incompatible types and
  // generated columns. Automatic selection never acknowledges warnings.
  return Object.fromEntries(sourceColumns.filter(column => targetNames.has(column.name)).map(column => [column.name, { target: column.name, transformation: "" }]));
}
