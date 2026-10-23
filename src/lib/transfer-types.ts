import type { ColumnInfo } from "./azureSql";
import type { ColumnMappingValues } from "./mapping-validation";
import type { ConnectionDetails } from "./database-config";

export interface TransferPlan {
  sourceName: string;
  targetName: string;
  sourceColumns: ColumnInfo[];
  targetColumns: ColumnInfo[];
  mappings: ColumnMappingValues;
  query?: { text: string; verificationId?: string };
}
export interface QueryVerificationRequest extends PreviewRequest { query: string; }
export interface PreviewRequest {
  sourceConnection: ConnectionDetails;
  targetConnection: ConnectionDetails;
  plan: TransferPlan;
  batchSize?: number;
  previousPreviewId?: string;
  skipCurrent?: boolean;
}
export type DisplayRow = Record<string, unknown>;
export interface PreviewResult {
  previewId: string;
  expiresAt: number;
  sourceName: string;
  targetName: string;
  sourceColumns: string[];
  targetColumns: string[];
  sourceRows: DisplayRow[];
  mappedRows: DisplayRow[];
  selectQuery: string;
  batchSize: number;
  batchNumber: number;
  hasMore: boolean;
  canContinue: boolean;
  batchMessage?: string;
}
export interface InsertResult { insertedRows: DisplayRow[]; columns: string[]; count: number; }

export interface TransferProgress {
  stage: string;
  level: "info" | "success" | "warning" | "error";
  message: string;
  processed?: number;
  total?: number;
  batchNumber?: number;
  chunkStart?: number;
  chunkEnd?: number;
}
export interface TransferFailure {
  error: string;
  stage?: string;
  details?: { exception?: string; code?: string; number?: number; line?: number; procedure?: string; message?: string };
}
export type TransferStreamEvent<T> =
  | { type: "progress"; event: TransferProgress }
  | { type: "result"; data: T }
  | { type: "error"; data: TransferFailure };
