import sql from "mssql";
import type { DbConnection } from "./azureSql";

export type ConnectionDetails = DbConnection | { connectionString: string };

export function databaseConfig(connection: ConnectionDetails): sql.config {
  if (!connection || typeof connection !== "object") throw new Error("Invalid connection details.");
  let config: sql.config;
  if ("connectionString" in connection) {
    if (typeof connection.connectionString !== "string" || !connection.connectionString.trim()) throw new Error("A full connection string is required.");
    try { config = sql.ConnectionPool.parseConnectionString(connection.connectionString.trim()); }
    catch { throw new Error("Invalid connection string. Use semicolon-separated Azure SQL connection settings."); }
    if ([config.server, config.database, config.user, config.password].some(value => typeof value !== "string" || !value.trim())) throw new Error("The connection string must include Server, Database (or Initial Catalog), User ID, and Password.");
  } else {
    if ([connection.server, connection.database, connection.userName, connection.password].some(value => typeof value !== "string" || !value.trim())) throw new Error("Server, database, username, and password are required.");
    config = { server: connection.server, database: connection.database, user: connection.userName, password: connection.password };
  }
  return { ...config, connectionTimeout: config.connectionTimeout ?? 10000, requestTimeout: config.requestTimeout ?? 30000, options: { encrypt: true, trustServerCertificate: false, ...config.options } };
}
