import { createHash, randomUUID } from "node:crypto";
import { sqlExpression, validateMapping, mappingBlockingMessages, requiredTargetErrors, type ColumnMappingValues } from "./mapping-validation";
import type { ColumnInfo } from "./azureSql";
import type { ConnectionDetails } from "./database-config";
import type { DisplayRow, InsertResult, PreviewRequest, PreviewResult, QueryVerificationRequest, TransferProgress } from "./transfer-types";
import { derivedQuery, parseQueryPreview, queryPrimaryKeyColumns, validateQueryPredicates, validateQueryResult } from "./query-validation";

export interface TableColumn extends ColumnInfo { identity?: boolean; computed?: boolean; hasDefault?: boolean; }
export interface DatabaseGateway {
  connect(): Promise<void>;
  close(): Promise<void>;
  columns(table: string): Promise<TableColumn[]>;
  describe(query: string): Promise<ColumnInfo[]>;
  select(query: string, parameters?: QueryParameter[]): Promise<DisplayRow[]>;
  begin(): Promise<void>;
  insert(table: string, columns: string[], values: unknown[], outputColumns: string[], sourceColumns?: ColumnInfo[]): Promise<DisplayRow[]>;
  insertBatch?(table: string, columns: string[], rows: unknown[][], outputColumns: string[], sourceColumns?: ColumnInfo[]): Promise<DisplayRow[]>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}
export class TransferError extends Error {
  constructor(message: string, public status = 400, public cause?: unknown) { super(message); }
}
export interface QueryParameter { name: string; value: unknown; }
export const MAX_BATCH_SIZE = 1000;
export const insertChunkSize = (columnCount: number) => Math.max(1, Math.min(1000, Math.floor(2000 / columnCount)));

function cursorType(column: ColumnInfo): string | null {
  const type = column.dataType.toLowerCase();
  if (["int","bigint","smallint","tinyint","bit","money","smallmoney","real","date","datetime","smalldatetime","uniqueidentifier"].includes(type)) return type;
  if (["decimal","numeric"].includes(type) && Number.isInteger(column.precision) && Number.isInteger(column.scale)) return `${type}(${column.precision},${column.scale})`;
  if (["datetime2","datetimeoffset","time"].includes(type) && Number.isInteger(column.datetimePrecision)) return `${type}(${column.datetimePrecision})`;
  if (type === "float" && Number.isInteger(column.precision)) return `float(${column.precision})`;
  if (["varchar","nvarchar","char","nchar","binary","varbinary"].includes(type) && Number.isInteger(column.maxLength) && column.maxLength > 0) return `${type}(${column.maxLength})`;
  return null;
}

export function batchSelect(expressions: string[], from: string, candidateKeys: ColumnInfo[], size: number, after?: unknown[], qualifier = "", outputNames: string[] = []) {
  const keys = candidateKeys.length && candidateKeys.every(key => !key.nullable && cursorType(key)) ? candidateKeys : [];
  if (after && after.length !== keys.length) throw new TransferError("The source primary key changed. Start a new batch sequence.");
  const ref = (key: ColumnInfo) => `${qualifier}${quoteIdentifier(key.name)}`;
  const cursorAliases = keys.map((_,i) => {
    let alias = `__etl_cursor_${i}`;
    while (outputNames.some(name => name.toLowerCase() === alias.toLowerCase())) alias = `_${alias}`;
    return alias;
  });
  const projection = [...expressions, ...keys.map((key,i) => `${preservedSqlValue(ref(key),key)} AS ${quoteIdentifier(cursorAliases[i])}`)];
  const parameter = (i: number) => `CONVERT(${cursorType(keys[i])}, @after${i})`;
  const where = after ? ` WHERE ${keys.map((key,i) => `(${[...keys.slice(0,i).map((previous,j) => `${ref(previous)} = ${parameter(j)}`), `${ref(key)} > ${parameter(i)}`].join(" AND ")})`).join(" OR ")}` : "";
  const order = keys.length ? ` ORDER BY ${keys.map(key => `${ref(key)} ASC`).join(", ")}` : "";
  return { query: `SELECT TOP (${size + 1}) ${projection.join(", ")} FROM ${from}${where}${order};`, parameters: after?.map((value,i) => ({ name: `after${i}`, value })) ?? [], keys, cursorAliases };
}
export const quoteIdentifier = (name: string) => `[${name.replaceAll("]", "]]")}]`;
export function tableIdentifier(table: string): string {
  if (typeof table !== "string") throw new TransferError("Select a valid source and target table in Mapping.");
  const parts = table.split(".");
  if (parts.length !== 2 || parts.some(part => !part.trim())) throw new TransferError("Select a table with a schema-qualified name, such as dbo.Customers.");
  return parts.map(quoteIdentifier).join(".");
}

// Preserve exact SQL decimals/integers and temporal fractional digits through JSON
// and JavaScript. Returning JS Number/Date values would lose decimal or sub-ms data.
export function preservedSqlValue(expression: string, column: ColumnInfo): string {
  const type = column.dataType.toLowerCase();
  if (["float", "real"].includes(type)) return `CONVERT(nvarchar(100), (${expression}), 3)`;
  if (["money", "smallmoney"].includes(type)) return `CONVERT(nvarchar(128), (${expression}), 2)`;
  if (["tinyint", "smallint", "int", "bigint", "decimal", "numeric"].includes(type)) return `CONVERT(nvarchar(128), (${expression}))`;
  if (["date", "time", "datetime", "datetime2", "datetimeoffset", "smalldatetime"].includes(type)) return `CONVERT(nvarchar(64), (${expression}), 127)`;
  return expression;
}

export function insertionParameter(parameter: string, source: ColumnInfo | undefined, target: ColumnInfo | undefined): string {
  // Exact values travel as strings to avoid JS precision loss. Restore numeric
  // semantics before a reviewed numeric-to-BIT conversion (including fractions).
  if (target?.dataType.toLowerCase() === "bit" && source && ["tinyint","smallint","int","bigint","decimal","numeric","money","smallmoney","float","real"].includes(source.dataType.toLowerCase())) return `CONVERT(bit, CONVERT(float, ${parameter}))`;
  return parameter;
}

export interface TransferSnapshot {
  expiresAt: number;
  targetConnection: ConnectionDetails;
  targetName: string;
  targetColumns: string[];
  outputColumns: string[];
  values: unknown[][];
  sourceColumns: ColumnInfo[];
  mappings: ColumnMappingValues;
  state: "ready" | "inserting" | "completed" | "failed" | "skipped";
  result?: InsertResult;
  paging?: { fingerprint: string; batchSize: number; batchNumber: number; hasMore: boolean; keys: ColumnInfo[]; after: unknown[] };
  preview?: PreviewResult;
  nextPreviewId?: string;
  advancing?: boolean;
}

export interface VerifiedQuery {
  expiresAt: number;
  fingerprint: string;
  text: string;
  selectQuery: string;
  targetNames: string[];
}

function queryFingerprint(request: PreviewRequest): string {
  return createHash("sha256").update(JSON.stringify([request.sourceConnection, request.targetConnection, request.plan.sourceName, request.plan.targetName, request.plan.mappings])).digest("hex");
}
const batchFingerprint = (request: PreviewRequest) => createHash("sha256").update(JSON.stringify([queryFingerprint(request), request.plan.query?.text ?? null])).digest("hex");

export function queryResultSelect(query: string, columns: ColumnInfo[]): string {
  return `SELECT ${columns.map(column => `${preservedSqlValue(`[_query].${quoteIdentifier(column.name)}`, column)} AS ${quoteIdentifier(column.name)}`).join(", ")} FROM (\n${derivedQuery(query)}) AS [_query];`;
}

// Server-side snapshots preserve exactly the batch reviewed by the user.
export class TransferService {
  constructor(private gateway: (connection: ConnectionDetails) => DatabaseGateway, private now = Date.now, private snapshots = new Map<string, TransferSnapshot>(), private verifiedQueries = new Map<string, VerifiedQuery>()) {}

  private expire() {
    for (const [id, snapshot] of this.snapshots) if (snapshot.expiresAt <= this.now() && snapshot.state !== "inserting" && !snapshot.advancing) this.snapshots.delete(id);
    for (const [id, query] of this.verifiedQueries) if (query.expiresAt <= this.now()) this.verifiedQueries.delete(id);
  }

  async verifyQuery(request: QueryVerificationRequest) {
    this.expire();
    if (!request?.plan || !request.sourceConnection || !request.targetConnection) throw new TransferError("Connect both databases and generate a query preview first.");
    const { selectQuery, targetNames } = parseQueryPreview(request.query, request.plan.sourceName, request.plan.targetName);
    tableIdentifier(request.plan.sourceName); tableIdentifier(request.plan.targetName);
    const source = this.gateway(request.sourceConnection), target = this.gateway(request.targetConnection);
    try {
      await source.connect(); await target.connect();
      validateQueryPredicates(request.query, await source.columns(request.plan.sourceName));
      const columns = await source.describe(selectQuery);
      const names = targetNames ?? columns.map(column => column.name);
      const warnings = validateQueryResult(columns, await target.columns(request.plan.targetName), names);
      // Check the actual SELECT used for loading as well as the displayed query.
      await source.describe(queryResultSelect(selectQuery, columns));
      const verificationId = randomUUID(), expiresAt = this.now() + 15 * 60 * 1000;
      this.verifiedQueries.set(verificationId, { text: request.query, selectQuery, targetNames: names, fingerprint: queryFingerprint(request), expiresAt });
      const expiry = setTimeout(() => this.verifiedQueries.delete(verificationId), 15 * 60 * 1000);
      expiry.unref();
      return { verificationId, expiresAt, warnings, message: "Query validation successful. This query's SELECT results will be used for Data Load. SQL syntax, source references, filter literal datatypes, target columns, and datatype compatibility passed. No query was executed. Runtime values and constraints are checked during loading." };
    } finally { await Promise.allSettled([source.close(), target.close()]); }
  }

  async preview(request: PreviewRequest, progress: (event: TransferProgress) => void = () => {}): Promise<PreviewResult> {
    const report = (stage: string, message: string, extra: Partial<TransferProgress> = {}) => progress({stage,message,level:"info",...extra});
    report("validate-request", "Checking the query, mappings, batch size, and continuation token.");
    this.expire();
    if (!request?.plan || !request.sourceConnection || !request.targetConnection) throw new TransferError("Connection and mapping details are missing. Return to Mapping and generate a valid query preview.");
    const { plan } = request;
    const batchSize = request.batchSize ?? MAX_BATCH_SIZE;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) throw new TransferError("Batch size must be a whole number from 1 to 1000.");
    const previous = request.previousPreviewId ? this.snapshots.get(request.previousPreviewId) : undefined;
    if (request.previousPreviewId && !previous) throw new TransferError("The previous batch expired. Start a new batch sequence.",410);
    if (previous) {
      if (previous.paging?.fingerprint !== batchFingerprint(request) || previous.paging.batchSize !== batchSize) throw new TransferError("The query, connection, mapping, or batch size changed. Start a new batch sequence.");
      if (previous.nextPreviewId) {
        const next = this.snapshots.get(previous.nextPreviewId)?.preview;
        if (!next) throw new TransferError("The next batch expired. Start a new batch sequence.",410);
        report("preview-ready", "Returning the existing next batch; no duplicate fetch was started.", {level:"success",processed:next.sourceRows.length,total:next.sourceRows.length,batchNumber:next.batchNumber});
        return next;
      }
      if (previous.advancing || previous.state === "inserting") throw new TransferError("This batch is busy. Wait for the current request to finish.",409);
      if (!previous.paging.hasMore || !previous.paging.keys.length) throw new TransferError("There is no safe next batch. A complete source primary key must be available in the result.");
      if (previous.state !== "completed" && !(previous.state === "ready" && request.skipCurrent === true)) throw new TransferError("Insert this batch first, or explicitly skip its uninserted records before fetching the next batch.",409);
    }
    const sourceTable = tableIdentifier(plan.sourceName);
    tableIdentifier(plan.targetName);
    let verified: VerifiedQuery | undefined;
    if (plan.query) {
      verified = this.verifiedQueries.get(plan.query.verificationId);
      if (!verified || verified.text !== plan.query.text || verified.fingerprint !== queryFingerprint(request)) throw new TransferError("This edited query is unverified, has changed, or its verification expired. Return to Mapping and click Verify Query before loading.");
    }
    if (!plan.mappings || typeof plan.mappings !== "object" || Array.isArray(plan.mappings)) throw new TransferError("Column mappings are missing. Return to Mapping and select target columns.");
    const source = this.gateway(request.sourceConnection), target = this.gateway(request.targetConnection);
    if (previous) previous.advancing = true;
    const pagingFor = (keys: ColumnInfo[]) => {
      if (previous && JSON.stringify(previous.paging.keys) !== JSON.stringify(keys)) throw new TransferError("The source primary key metadata changed. Start a new batch sequence.");
      return previous?.paging.after;
    };
    const finish = (preview: PreviewResult) => {
      report("preview-ready", `${preview.sourceRows.length} records fetched and mapped. Waiting for review and Confirm Insert.`, {level:"success",processed:preview.sourceRows.length,total:preview.sourceRows.length,batchNumber:preview.batchNumber});
      if (preview.batchMessage) report("continuation",preview.batchMessage,{level:"warning"});
      return preview;
    };
    try {
      report("connect-source", `Connecting to the source for ${plan.sourceName}.`);
      await source.connect();
      report("connect-target", `Connecting to the target for ${plan.targetName}.`);
      await target.connect();
      report("validate-schema", "Reading source and target column metadata and checking mapping compatibility.");
      const sourceColumns = await source.columns(plan.sourceName), targetColumns = await target.columns(plan.targetName);
      if (!sourceColumns.length || !targetColumns.length) throw new TransferError("The selected source or target table no longer exists or cannot be read. Reload tables in Connect.");
      if (verified) {
        report("validate-query", "Checking the verified SELECT, filter datatypes, result columns, and primary key.");
        validateQueryPredicates(verified.text, sourceColumns);
        const columns = await source.describe(verified.selectQuery);
        validateQueryResult(columns, targetColumns, verified.targetNames);
        const candidates = queryPrimaryKeyColumns(verified.selectQuery, sourceColumns);
        const batch = batchSelect(columns.map(column => `${preservedSqlValue(`[_query].${quoteIdentifier(column.name)}`,column)} AS ${quoteIdentifier(column.name)}`), `(\n${derivedQuery(verified.selectQuery)}) AS [_query]`, candidates, batchSize, pagingFor(candidates), "[_query].", columns.map(column=>column.name));
        report("fetch-source", `Executing the verified SELECT for up to ${batchSize} records plus one continuation check. SQL execution progress is not available until the query returns.`);
        const fetched = await source.select(batch.query,batch.parameters);
        report("map-records", "Preparing the fetched source values and mapped target records.");
        const hasMore = fetched.length > batchSize;
        const rows = fetched.slice(0,batchSize).map(row => Object.fromEntries(columns.map(column=>[column.name,row[column.name]])));
        const values = rows.map(row => columns.map(column => row[column.name]));
        const mappedRows = values.map(row => Object.fromEntries(verified.targetNames.map((name, index) => [name, row[index]])));
        const mappings = Object.fromEntries(columns.map((column, index) => {
          const mapping = { target: verified.targetNames[index], transformation: "", reviewedWarnings: [] as string[] };
          mapping.reviewedWarnings = validateMapping(column, mapping, targetColumns, {}).warnings;
          return [column.name, mapping];
        }));
        return finish(this.savePreview(request, columns, targetColumns, verified.targetNames, rows, mappedRows, values, batch.query, mappings, this.pageInfo(request,batchSize,batch, fetched,previous,hasMore)));
      }
      for (const [name, mapping] of Object.entries(plan.mappings)) {
        if (!mapping || typeof mapping.target !== "string" || typeof mapping.transformation !== "string") throw new TransferError(`Invalid mapping for column "${name}". Recreate this mapping.`);
        if (mapping.target && !sourceColumns.some(column => column.name === name)) throw new TransferError(`Source column "${name}" no longer exists. Reload its table and update the mapping.`);
      }
      const selected = sourceColumns.filter(column => plan.mappings[column.name]?.target);
      if (!selected.length) throw new TransferError("Map at least one column before fetching source records.");
      const errors = selected.flatMap(column => mappingBlockingMessages(validateMapping(column, plan.mappings[column.name], targetColumns, plan.mappings), plan.mappings[column.name]));
      const names = selected.map(column => plan.mappings[column.name].target);
      for (const column of targetColumns) {
        if (names.includes(column.name) && (column.identity || column.computed)) errors.push(`Target "${column.name}" is generated by SQL Server. Leave it unmapped.`);
      }
      errors.push(...requiredTargetErrors(targetColumns, plan.mappings));
      if (errors.length) throw new TransferError([...new Set(errors)].join(" "));
      const expressions = selected.flatMap((column, index) => [
        `${preservedSqlValue(quoteIdentifier(column.name), column)} AS ${quoteIdentifier(`__source_${index}`)}`,
        `${preservedSqlValue(sqlExpression(plan.mappings[column.name].transformation, column.name), column)} AS ${quoteIdentifier(`__mapped_${index}`)}`,
      ]);
      const keys = sourceColumns.filter(column => column.primaryKeyOrdinal > 0).sort((a,b) => a.primaryKeyOrdinal-b.primaryKeyOrdinal);
      const batch = batchSelect(expressions,sourceTable,keys,batchSize,pagingFor(keys));
      report("fetch-source", `Executing the source SELECT for up to ${batchSize} records plus one continuation check. SQL execution progress is not available until the query returns.`);
      const fetched = await source.select(batch.query,batch.parameters);
      report("map-records", "Preparing the fetched source values and mapped target records.");
      const hasMore = fetched.length > batchSize;
      const rows = fetched.slice(0,batchSize);
      const values = rows.map(row => selected.map((_, index) => row[`__mapped_${index}`]));
      const sourceRows = rows.map(row => Object.fromEntries(selected.map((column, index) => [column.name, row[`__source_${index}`]])));
      const mappedRows = values.map(row => Object.fromEntries(names.map((name, index) => [name, row[index]])));
      return finish(this.savePreview(request, selected, targetColumns, names, sourceRows, mappedRows, values, batch.query, plan.mappings, this.pageInfo(request,batchSize,batch,fetched,previous,hasMore)));
    } finally { if (previous) previous.advancing = false; await Promise.allSettled([source.close(), target.close()]); }
  }

  private pageInfo(request: PreviewRequest, batchSize: number, batch: ReturnType<typeof batchSelect>, rows: DisplayRow[], previous: TransferSnapshot | undefined, hasMore: boolean): NonNullable<TransferSnapshot["paging"]> {
    const last = rows[Math.min(rows.length,batchSize)-1];
    const after = batch.keys.length && last ? batch.cursorAliases.map(name => last[name]) : [];
    if (after.some(value => value === undefined || value === null)) throw new TransferError("The source did not return the primary key needed to continue safely.");
    return { fingerprint: batchFingerprint(request), batchSize, batchNumber: (previous?.paging.batchNumber ?? 0)+1, keys: batch.keys.map(key=>({...key})), after, hasMore };
  }

  private savePreview(request: PreviewRequest, columns: ColumnInfo[], targetColumns: ColumnInfo[], names: string[], sourceRows: DisplayRow[], mappedRows: DisplayRow[], values: unknown[][], selectQuery: string, mappings: ColumnMappingValues, paging: NonNullable<TransferSnapshot["paging"]>): PreviewResult {
    const previewId = randomUUID(), expiresAt = this.now() + 15 * 60 * 1000;
    const { plan } = request;
    const canContinue = paging.hasMore && paging.keys.length > 0;
    const preview: PreviewResult = { previewId, expiresAt, sourceName: plan.sourceName, targetName: plan.targetName, sourceColumns: columns.map(column => column.name), targetColumns: names, sourceRows, mappedRows, selectQuery, batchSize: paging.batchSize, batchNumber: paging.batchNumber, hasMore: paging.hasMore, canContinue,
      ...(paging.hasMore && !canContinue ? { batchMessage: "Only this limited batch is shown. To continue safely, the source needs a supported primary key, and an edited SELECT must include its unchanged key columns without grouping or UNION. Narrow your filter or include the key and verify again." } : {}) };
    this.snapshots.set(previewId, { expiresAt, targetConnection: request.targetConnection, targetName: plan.targetName, targetColumns: names, outputColumns: targetColumns.map(column => column.name), sourceColumns: columns, mappings, values, state: "ready", paging, preview });
    const previous = request.previousPreviewId ? this.snapshots.get(request.previousPreviewId) : undefined;
    if (previous) {
      previous.nextPreviewId = previewId;
      previous.values = [];
      previous.preview = undefined;
      previous.targetConnection = null;
      previous.expiresAt = expiresAt;
      if (previous.result) previous.result = { ...previous.result, insertedRows: [] };
      if (previous.state === "ready") previous.state = "skipped";
    }
    const expiry = setTimeout(() => { const snapshot = this.snapshots.get(previewId); if (snapshot && snapshot.expiresAt <= this.now() && snapshot.state !== "inserting" && !snapshot.advancing) this.snapshots.delete(previewId); }, 15 * 60 * 1000);
    expiry.unref();
    return preview;
  }

  async confirm(previewId: string, progress: (event: TransferProgress) => void = () => {}): Promise<InsertResult> {
    let active: TransferProgress = {stage:"validate-preview",level:"info",message:"Checking the reviewed batch and insert status."};
    const report = (stage: string, message: string, extra: Partial<TransferProgress> = {}) => { active = {stage,message,level:"info",...extra}; progress(active); };
    progress(active);
    this.expire();
    const snapshot = this.snapshots.get(previewId);
    if (!snapshot) throw new TransferError("This source preview expired or the server restarted. Click Start Data Load to fetch the records again.", 410);
    if (snapshot.advancing) throw new TransferError("The next batch is being fetched. Wait for it to finish.",409);
    if (snapshot.state === "completed") {
      report("completed", "This batch was already committed. Returning its existing result without another insert.", {level:"success",processed:snapshot.result!.count,total:snapshot.result!.count});
      return snapshot.result!;
    }
    if (snapshot.state !== "ready") throw new TransferError(snapshot.state === "inserting" ? "This batch is already being inserted. Wait for the first request to finish." : "This batch cannot be retried. Check the target table before fetching a new batch.", 409);
    if (!snapshot.values.length) throw new TransferError("The source table returned no records. There is nothing to insert.");
    snapshot.state = "inserting";
    let target: DatabaseGateway | undefined, began = false, committing = false;
    const total = snapshot.values.length, batchNumber = snapshot.paging?.batchNumber;
    const counts = {total,batchNumber,processed:0};
    try {
      report("connect-target", `Connecting to ${snapshot.targetName} for insertion.`,counts);
      target = this.gateway(snapshot.targetConnection);
      await target.connect();
      report("validate-target", "Rechecking target columns, required values, and mapping compatibility.",counts);
      const currentColumns = await target.columns(snapshot.targetName);
      const errors = snapshot.sourceColumns.flatMap(column => mappingBlockingMessages(validateMapping(column, snapshot.mappings[column.name], currentColumns, snapshot.mappings), snapshot.mappings[column.name]));
      errors.push(...requiredTargetErrors(currentColumns, snapshot.mappings));
      if (errors.length) throw new TransferError(`The target schema no longer matches the source preview. ${[...new Set(errors)].join(" ")} Reload tables and generate a new preview.`);
      snapshot.outputColumns = currentColumns.map(column => column.name);
      report("begin-transaction", "Opening a transaction for the reviewed batch.",counts);
      await target.begin();
      began = true;
      const insertedRows: DisplayRow[] = [];
      if (target.insertBatch) {
        const chunkSize = insertChunkSize(snapshot.targetColumns.length);
        for (let start=0;start<snapshot.values.length;start+=chunkSize) {
          const end = Math.min(start+chunkSize,total);
          report("insert-chunk", `Writing batch rows ${start+1}-${end} of ${total}. These rows are not committed yet.`, {...counts,processed:start,chunkStart:start+1,chunkEnd:end});
          insertedRows.push(...await target.insertBatch(snapshot.targetName,snapshot.targetColumns,snapshot.values.slice(start,end),snapshot.outputColumns,snapshot.sourceColumns));
          report("insert-chunk", `Batch rows ${start+1}-${end} accepted; awaiting transaction commit.`, {...counts,processed:end,chunkStart:start+1,chunkEnd:end});
        }
      } else {
        for (let index=0;index<total;index++) {
          report("insert-chunk", `Writing batch row ${index+1} of ${total}; not committed yet.`,{...counts,processed:index,chunkStart:index+1,chunkEnd:index+1});
          insertedRows.push(...await target.insert(snapshot.targetName,snapshot.targetColumns,snapshot.values[index],snapshot.outputColumns,snapshot.sourceColumns));
        }
      }
      committing = true;
      report("commit", `All ${total} batch rows accepted. Committing the transaction.`,{...counts,processed:total});
      await target.commit();
      snapshot.result = { insertedRows, columns: snapshot.outputColumns, count: insertedRows.length };
      snapshot.state = "completed";
      // Retain only the result needed to answer a repeated confirmation.
      snapshot.values = [];
      snapshot.targetConnection = null;
      report("completed", `${snapshot.result.count} records committed successfully to ${snapshot.targetName}.`,{...counts,processed:total,level:"success"});
      return snapshot.result;
    } catch (error) {
      snapshot.state = "failed";
      progress({...active,level:"error",message:`Processing failed at ${active.stage}${active.chunkStart ? `, batch rows ${active.chunkStart}-${active.chunkEnd}` : ""}. See the exception details below.`});
      if (began) {
        report("rollback", "Attempting to roll back this batch transaction.",{...counts,level:"warning"});
        try {
          await target!.rollback();
          report("rollback", committing ? "Rollback request finished, but the commit outcome is uncertain. Check the target table before another load." : "Rollback completed. No records from this batch were committed.",{...counts,level:committing ? "warning" : "success"});
        }
        catch {
          report("rollback", "Rollback could not be confirmed. The target outcome is unknown; check the target table before another load.",{...counts,level:"error"});
          throw new TransferError("The connection was lost and the insert outcome could not be verified. Check the target table before starting another load.", 500,error);
        }
      }
      if (committing) throw new TransferError("The commit outcome could not be verified. Check the target table before starting another load.", 500,error);
      throw error;
    } finally { if (target) await target.close().catch(() => undefined); }
  }
}
