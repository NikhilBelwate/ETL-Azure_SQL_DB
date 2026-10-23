import type { ColumnInfo } from "./azureSql";

export type CompatibilityStatus = "ACCEPT" | "WARN" | "REJECT" | "UNKNOWN";
export interface CustomCompatibilityRule {
  sourceType: string;
  targetType: string;
  status: CompatibilityStatus;
  message: string;
  // Configure only after reviewing the source/target domains and actual SQL conversion.
  matches?: (source: ColumnInfo, target: ColumnInfo) => boolean;
}
export interface CompatibilityPolicy { customRules: readonly CustomCompatibilityRule[]; }

// Server-owned extension point for reviewed ENUM, XML schema, JSON schema, spatial,
// UDT and cross-database conversions. Client requests cannot supply these rules.
// Example: { sourceType: "my_enum", targetType: "my_enum", status: "WARN",
// message: "Reviewed enum conversion; confirm application semantics.", matches: ... }
export const compatibilityPolicy: CompatibilityPolicy = { customRules: [] };
