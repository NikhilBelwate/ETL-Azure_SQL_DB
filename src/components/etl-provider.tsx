"use client";
import { createContext, useContext, useState } from "react";
import type { DbConnection, TableInfo } from "@/lib/azureSql";
import type { TransferPlan } from "@/lib/transfer-types";
export type DbId = "db1" | "db2";
export interface DatabaseState { connection: DbConnection; connectionMode: "string" | "fields"; connectionString: string; tables: TableInfo[]; selectedTable: string; }
const emptyDatabase = (): DatabaseState => ({ connection: { server: "", database: "", userName: "", password: "" }, connectionMode: "string", connectionString: "", tables: [], selectedTable: "" });
type Databases = Record<DbId, DatabaseState>;
type MappingDraft = Omit<TransferPlan, "query">;
const EtlContext = createContext<{ databases: Databases; plan: TransferPlan | null; setPlan: (plan: TransferPlan | null) => void; mappingDraft: MappingDraft | null; setMappingDraft: (draft: MappingDraft | null) => void; updateDatabase: (id: DbId, update: (previous: DatabaseState) => DatabaseState) => void; } | null>(null);
export function EtlProvider({ children }: { children: React.ReactNode }) {
  const [databases, setDatabases] = useState<Databases>({ db1: emptyDatabase(), db2: emptyDatabase() });
  const [plan, setPlan] = useState<TransferPlan | null>(null);
  const [mappingDraft, setMappingDraft] = useState<MappingDraft | null>(null);
  const updateDatabase = (id: DbId, update: (previous: DatabaseState) => DatabaseState) => { setPlan(null); setMappingDraft(null); setDatabases(previous => ({ ...previous, [id]: update(previous[id]) })); };
  return <EtlContext.Provider value={{ databases, plan, setPlan, mappingDraft, setMappingDraft, updateDatabase }}>{children}</EtlContext.Provider>;
}
export function useEtl() {
  const context = useContext(EtlContext);
  if (!context) throw new Error("ETL context is unavailable");
  return context;
}
