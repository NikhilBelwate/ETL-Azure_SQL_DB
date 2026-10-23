export { default as sql } from 'mssql';

export interface ColumnInfo {
  name: string;
  dataType: string;
  maxLength?: number;
  precision?: number;
  scale?: number;
  datetimePrecision?: number;
  collation?: string | null;
  codePage?: number | null;
  unsigned?: boolean;
  integerRange?: { min: string; max: string };
  dialect?: "sqlserver" | "mysql" | "postgresql" | "custom";
  enumValues?: string[];
  xmlSchema?: string | null;
  userDefinedType?: string | null;
  identity?: boolean;
  computed?: boolean;
  hasDefault?: boolean;
  primaryKeyOrdinal?: number;
  nullable: boolean;
}

export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
}

export interface DbConnection {
  server: string;
  database: string;
  userName: string;
  password: string;
  options?: {
    encrypt?: boolean;
    trustServerCertificate?: boolean;
  };
}
