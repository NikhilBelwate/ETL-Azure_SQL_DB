import sql from "mssql";
import { databaseConfig, type ConnectionDetails } from "./database-config";
import { insertionParameter, insertChunkSize, preservedSqlValue, quoteIdentifier, tableIdentifier, TransferError, TransferService, type DatabaseGateway, type TransferSnapshot, type VerifiedQuery } from "./transfer-service";
import type { ColumnInfo } from "./azureSql";

export function gateway(connection: ConnectionDetails): DatabaseGateway {
  let config: sql.config;
  try { config = databaseConfig(connection); }
  catch (error) { throw new TransferError(error instanceof Error ? error.message : "Invalid connection details."); }
  const pool = new sql.ConnectionPool(config);
  let transaction: sql.Transaction | undefined, rolledBack = false;
  let tableColumns: ColumnInfo[] = [];
  const insertRows: NonNullable<DatabaseGateway["insertBatch"]> = async (table,columns,rows,outputColumns,sourceColumns=[]) => {
    if (!rows.length || rows.length > insertChunkSize(columns.length) || rows.some(row=>row.length!==columns.length)) throw new TransferError("Invalid insert batch size or column count.");
    const request = new sql.Request(transaction);
    const output = outputColumns.map(name => `${preservedSqlValue(`INSERTED.${quoteIdentifier(name)}`,tableColumns.find(column=>column.name===name)!)} AS ${quoteIdentifier(name)}`).join(", ");
    const tuples = rows.map((row,rowIndex) => `(${row.map((value,index) => {
      const parameter = `value${rowIndex}_${index}`;
      request.input(parameter,value);
      return insertionParameter(`@${parameter}`,sourceColumns[index],tableColumns.find(column=>column.name===columns[index]));
    }).join(", ")})`);
    return (await request.query(`INSERT INTO ${tableIdentifier(table)} (${columns.map(quoteIdentifier).join(", ")}) OUTPUT ${output} VALUES ${tuples.join(", ")};`)).recordset;
  };
  return {
    connect: async () => { await pool.connect(); },
    close: async () => { await pool.close(); },
    describe: async query => {
      const description = await pool.request().input("query", sql.NVarChar(sql.MAX), query).query(`
        SELECT *, CONVERT(int, COLLATIONPROPERTY(collation_name, 'CodePage')) AS code_page
        FROM sys.dm_exec_describe_first_result_set(@query, NULL, 0) ORDER BY column_ordinal`);
      const failure = description.recordset.find(row => row.error_number);
      if (failure) throw new TransferError(failure.error_message || "SQL Server could not validate the query.");
      if (!description.recordset.length) throw new TransferError("The SELECT must return columns for the target mapping.");
      return description.recordset.map(row => {
        if (!row.system_type_name) throw new TransferError("SQL Server could not determine a result datatype. Use explicit casts to supported SQL types.");
        const dataType = row.system_type_name.split("(")[0].toLowerCase();
        return { name: row.name, dataType, nullable: !!row.is_nullable,
          maxLength: ["nvarchar", "nchar"].includes(dataType) && row.max_length > 0 ? row.max_length / 2 : row.max_length,
          precision: row.precision, scale: row.scale, datetimePrecision: row.scale,
          collation: row.collation_name, codePage: row.code_page,
          userDefinedType: row.user_type_name || null, xmlSchema: row.xml_collection_name || null, dialect: "sqlserver" as const };
      });
    },
    columns: async table => {
      const [schema, name] = table.split(".");
      const result = await pool.request().input("schema", sql.NVarChar, schema).input("table", sql.NVarChar, name).query(`
        SELECT c.name, CASE WHEN ty.is_assembly_type = 1 THEN ty.name ELSE TYPE_NAME(c.system_type_id) END AS dataType, c.is_nullable AS nullable,
          c.precision AS [precision], c.scale, c.scale AS datetimePrecision,
          c.collation_name AS collation, CONVERT(int, COLLATIONPROPERTY(c.collation_name, 'CodePage')) AS codePage,
          CASE WHEN ty.is_user_defined = 1 THEN QUOTENAME(SCHEMA_NAME(ty.schema_id)) + '.' + QUOTENAME(ty.name) ELSE NULL END AS userDefinedType,
          CASE WHEN c.xml_collection_id > 0 THEN COALESCE(QUOTENAME(SCHEMA_NAME(xs.schema_id)) + '.' + QUOTENAME(xs.name), 'Typed XML (schema metadata unavailable)') ELSE NULL END AS xmlSchema,
          CASE WHEN TYPE_NAME(c.system_type_id) IN ('nvarchar', 'nchar') AND c.max_length > 0 THEN c.max_length / 2 ELSE c.max_length END AS maxLength,
          c.is_identity AS [identity], c.is_computed AS computed, CASE WHEN c.default_object_id > 0 THEN 1 ELSE 0 END AS hasDefault,
          (SELECT ic.key_ordinal FROM sys.indexes ix JOIN sys.index_columns ic ON ic.object_id=ix.object_id AND ic.index_id=ix.index_id
            WHERE ix.object_id=c.object_id AND ix.is_primary_key=1 AND ic.column_id=c.column_id) AS primaryKeyOrdinal
        FROM sys.columns c JOIN sys.tables t ON t.object_id = c.object_id JOIN sys.schemas s ON s.schema_id = t.schema_id
        JOIN sys.types ty ON ty.user_type_id = c.user_type_id
        LEFT JOIN sys.xml_schema_collections xs ON xs.xml_collection_id = c.xml_collection_id
        WHERE s.name = @schema AND t.name = @table ORDER BY c.column_id`);
      tableColumns = result.recordset;
      return result.recordset;
    },
    select: async (query,parameters=[]) => {
      const request = pool.request();
      parameters.forEach(parameter=>request.input(parameter.name,parameter.value));
      return (await request.query(query)).recordset;
    },
    begin: async () => { transaction = new sql.Transaction(pool); transaction.on("rollback", () => { rolledBack = true; }); await transaction.begin(); },
    insert: async (table,columns,values,outputColumns,sourceColumns) => insertRows(table,columns,[values],outputColumns,sourceColumns),
    insertBatch: insertRows,
    commit: async () => { await transaction!.commit(); },
    rollback: async () => { if (transaction && !rolledBack) await transaction.rollback(); },
  };
}

// Preserve batches across hot reloads while always using the latest validation and gateway code.
const globalTransfer = globalThis as typeof globalThis & { etlTransferSnapshots?: Map<string, TransferSnapshot>; etlVerifiedQueries?: Map<string, VerifiedQuery> };
export const transferService = new TransferService(gateway, Date.now, globalTransfer.etlTransferSnapshots ??= new Map(), globalTransfer.etlVerifiedQueries ??= new Map());

export function transferErrorResponse(error: unknown, operation: "fetch" | "insert", stage?: string) {
  const detail = (error instanceof TransferError && error.cause ? error.cause : error) as { number?: number; code?: string; name?: string; lineNumber?: number; procName?: string; originalError?: { info?: { message?: string; number?: number; lineNumber?: number; procName?: string } } };
  const info = detail?.originalError?.info;
  // Only expose database diagnostics, never connection objects or stack traces.
  // Login/connection errors can contain credentials, so omit their raw text.
  const redact = (value: string) => value.replace(/\b(password|pwd|user\s*id|uid|access\s*token)\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^;\s]*)/gi,"$1=[redacted]").slice(0,2000);
  const details = {
    exception: detail?.name,
    code: detail?.code,
    number: detail?.number ?? info?.number,
    line: detail?.lineNumber ?? info?.lineNumber,
    procedure: info?.procName ?? detail?.procName,
    ...((detail?.code === "EREQUEST" && (detail?.number ?? info?.number) !== 18456) ? {message:redact(info?.message ?? (error instanceof Error ? error.message : "Database request failed."))} : {}),
  };
  if (error instanceof TransferError) return Response.json({ error: error.message,stage,details }, { status: error.status });
  const reasons: Record<number, string> = {
    2601: "A target unique key already exists. Check for duplicate source records or rows previously inserted.",
    2627: "A target primary or unique key already exists. Check for duplicate source records or rows previously inserted.",
    515: "A required target column received NULL. Update its mapping or remove NULL values from the source.",
    547: "A target foreign key or check constraint rejected a record. Check target relationships and allowed values.",
    8152: "A value is longer than the target column allows. Check text and binary column lengths.",
    2628: "A value is longer than the target column allows. Check text and binary column lengths.",
    8115: "A value overflowed its numeric type. Check the formula and target range, precision, and scale.",
    8134: "A source value caused division by zero. Change the transformation formula.",
    245: "A value could not be converted to its target datatype. Check the column mapping.",
    8114: "A value could not be converted to its target datatype. Check the column mapping.",
    207: "A mapped column no longer exists. Reload table metadata and update Mapping.",
    208: "The selected table no longer exists or is inaccessible. Reload tables in Connect.",
    229: "The database user does not have the required SELECT or INSERT permission.",
    334: "The target has an enabled trigger that prevents returning inserted records with OUTPUT. Use a target without this trigger or update its insert strategy.",
    544: "An identity column cannot accept an explicit value. Leave generated target columns unmapped.",
  };
  const reason = reasons[detail?.number] || (detail?.code === "ELOGIN" ? "Database sign-in failed. Check the connection credentials." : detail?.code === "ETIMEOUT" ? "The database request timed out. Check connectivity and retry only after checking the target table." : "The database request failed. Check the connection, table permissions, constraints, and mapping.");
  return Response.json({ error: `${operation === "fetch" ? "Source fetch failed." : "Insert failed."} ${reason}`, stage, details }, { status: 500 });
}
