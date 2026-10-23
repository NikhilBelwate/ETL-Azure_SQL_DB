import sql from "mssql";
import { databaseConfig, type ConnectionDetails } from "./database-config";
import type { TableInfo } from "./azureSql";

export async function fetchTables(request: Request) {
  let details: ConnectionDetails;
  try { details = await request.json(); } catch { return Response.json({error:"Invalid connection details."},{status:400}); }
  let config: sql.config;
  try { config = databaseConfig(details); } catch (error) { return Response.json({error:error instanceof Error ? error.message : "Invalid connection details."},{status:400}); }
  const pool = new sql.ConnectionPool(config);
  try {
    await pool.connect();
    const result = await pool.request().query(`
      SELECT s.name AS TABLE_SCHEMA, t.name AS TABLE_NAME, c.name AS COLUMN_NAME,
        CASE WHEN ty.is_assembly_type = 1 THEN ty.name ELSE TYPE_NAME(c.system_type_id) END AS DATA_TYPE,
        c.is_nullable AS nullable,
        CASE WHEN TYPE_NAME(c.system_type_id) IN ('nvarchar','nchar') AND c.max_length > 0 THEN c.max_length / 2 ELSE c.max_length END AS maxLength,
        c.precision AS [precision], c.scale, c.scale AS datetimePrecision,
        c.collation_name AS collation, CONVERT(int, COLLATIONPROPERTY(c.collation_name, 'CodePage')) AS codePage,
        c.is_identity AS [identity], c.is_computed AS computed, CASE WHEN c.default_object_id > 0 THEN 1 ELSE 0 END AS hasDefault,
        CASE WHEN ty.is_user_defined = 1 THEN QUOTENAME(SCHEMA_NAME(ty.schema_id)) + '.' + QUOTENAME(ty.name) ELSE NULL END AS userDefinedType,
        CASE WHEN c.xml_collection_id > 0 THEN COALESCE(QUOTENAME(SCHEMA_NAME(xs.schema_id)) + '.' + QUOTENAME(xs.name), 'Typed XML (schema metadata unavailable)') ELSE NULL END AS xmlSchema
      FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
      JOIN sys.columns c ON c.object_id = t.object_id JOIN sys.types ty ON ty.user_type_id = c.user_type_id
      LEFT JOIN sys.xml_schema_collections xs ON xs.xml_collection_id = c.xml_collection_id
      WHERE t.is_ms_shipped = 0 ORDER BY s.name, t.name, c.column_id`);
    const tables = new Map<string,TableInfo>();
    for (const row of result.recordset) {
      const name = `${row.TABLE_SCHEMA}.${row.TABLE_NAME}`;
      if (!tables.has(name)) tables.set(name,{name,columns:[]});
      tables.get(name)!.columns.push({name:row.COLUMN_NAME,dataType:row.DATA_TYPE.toLowerCase(),nullable:Boolean(row.nullable),maxLength:row.maxLength,precision:row.precision,scale:row.scale,datetimePrecision:row.datetimePrecision,collation:row.collation,codePage:row.codePage,identity:Boolean(row.identity),computed:Boolean(row.computed),hasDefault:Boolean(row.hasDefault),xmlSchema:row.xmlSchema,userDefinedType:row.userDefinedType,dialect:"sqlserver"});
    }
    return Response.json({tables:[...tables.values()]});
  } catch { return Response.json({error:"Unable to load table metadata. Check credentials, Azure SQL firewall settings, and metadata permissions."},{status:500}); }
  finally { await pool.close(); }
}
