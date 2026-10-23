import sqlParser, { type AST } from "node-sql-parser";
import type { ColumnInfo } from "./azureSql";
import { assessCompatibility } from "./type-compatibility";
import { requiredTargetErrors } from "./mapping-validation";

const parser = new sqlParser.Parser();
const options = { database: "TransactSQL" };
type Node = { [key: string]: unknown; type?: string };

// Parse the preview as data. User SQL is never submitted for execution.
export function parseQueryPreview(query: string, sourceName: string, targetName: string) {
  if (typeof query !== "string" || !query.trim()) throw new Error("Enter a query before verifying.");
  if (query.length > 50000) throw new Error("The query must be 50,000 characters or fewer.");
  let statements: Node[];
  try {
    const ast = parser.astify(query, options);
    statements = (Array.isArray(ast) ? ast : [ast]) as unknown as Node[];
  } catch (error) {
    const detail = error as { location?: { start?: { line: number; column: number } } };
    const position = detail.location?.start;
    throw new Error(`SQL syntax is invalid${position ? ` at line ${position.line}, column ${position.column}` : ""}. Check statement syntax, commas, parentheses, and identifiers.`);
  }
  if (statements[0]?.type !== "select" || !(statements.length === 1 || statements.length === 2 && statements[1].type === "insert")) {
    throw new Error("Use one preview SELECT, optionally followed by one matching INSERT…SELECT statement. Other statements are not supported in this preview.");
  }
  const [select, insert] = statements;
  const tableName = (table: Node) => `${table.db}.${table.table}`;
  let columns: string[] | null = null;
  let insertionSelect: Node | undefined;
  if (insert) {
    const tables = insert.table as Node[] | undefined;
    if (tables?.length !== 1 || tableName(tables[0]) !== targetName || tables[0].schema) throw new Error(`The INSERT must target the selected table ${targetName}.`);
    if (!Array.isArray(insert.columns) || !insert.columns.length || insert.columns.some(column => typeof column !== "string")) throw new Error("Specify the target column names in INSERT.");
    columns = insert.columns as string[];
    if (new Set(columns).size !== columns.length) throw new Error("Each INSERT target column must appear only once.");
    insertionSelect = insert.values as Node | undefined;
    if (insertionSelect?.type !== "select") throw new Error("INSERT must use a SELECT from the selected source table.");
  }
  function inspect(value: unknown) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(inspect); return; }
    const node = value as Node;
    const divisor = node.right as Node | undefined;
    if (node.type === "binary_expr" && ["/", "%"].includes(String(node.operator)) && divisor?.type === "number" && Number(divisor.value) === 0) {
      throw new Error("The query divides by zero. Use a nonzero divisor or NULLIF to handle zero values.");
    }
    if (node.type === "select") {
      if ((node.into as Node | undefined)?.position) throw new Error("SELECT INTO is not supported in a query preview.");
      const from = node.from as Node[] | undefined;
      if (from?.length !== 1 || from.some(table => typeof table.table !== "string" || tableName(table) !== sourceName || table.schema)) throw new Error(`SELECT must read from the selected source table ${sourceName}. Joins and other tables are not supported in this preview.`);
    }
    Object.values(node).forEach(inspect);
  }
  inspect(select); inspect(insertionSelect);
  const serialize = (node: Node) => parser.sqlify(node as unknown as AST, options);
  if (insertionSelect && serialize(select) !== serialize(insertionSelect)) throw new Error("The preview SELECT and INSERT SELECT must match. Apply your changes to both statements.");
  // Preserve the user's SQL text. Serializing numeric ASTs can round decimal
  // literals, and must never change the SELECT that is verified or executed.
  const selectQuery = firstQueryStatement(query);
  if (insertionSelect && !selectQuery.terminated) throw new Error("End the preview SELECT with a semicolon before INSERT.");
  return { selectQuery: selectQuery.text, targetNames: columns };
}

function firstQueryStatement(query: string) {
  let depth = 0;
  for (let i = 0; i < query.length; i++) {
    const ch = query[i];
    if (ch === "'" || ch === '"' || ch === "[") {
      const end = ch === "[" ? "]" : ch;
      for (i++; i < query.length; i++) {
        if (query[i] === end) { if (query[i + 1] === end) i++; else break; }
      }
    } else if (ch === "-" && query[i + 1] === "-") {
      while (i < query.length && query[i] !== "\n" && query[i] !== "\r") i++;
    } else if (ch === "/" && query[i + 1] === "*") {
      let comments = 1;
      for (i += 2; i < query.length && comments; i++) {
        if (query[i] === "/" && query[i + 1] === "*") { comments++; i++; }
        else if (query[i] === "*" && query[i + 1] === "/") { comments--; i++; }
      }
      i--;
    } else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === ";" && depth === 0) return { text: query.slice(0, i).trim(), terminated: true };
  }
  return { text: query.trim(), terminated: false };
}

export function derivedQuery(query: string): string {
  const select = parser.astify(query, options) as unknown as Node;
  // SQL Server requires TOP or OFFSET for ORDER BY in a derived SELECT.
  return `${query}\n${select.orderby && !select.top && !select.limit ? "OFFSET 0 ROWS\n" : ""}`;
}

// Continuation requires the unchanged primary key to be present in the result.
// A UNION/grouped result can repeat or collapse keys, so it cannot use this path.
export function queryPrimaryKeyColumns(query: string, sourceColumns: ColumnInfo[]): ColumnInfo[] {
  const select = parser.astify(query, options) as unknown as Node;
  if (select._next || select.set_op || select.groupby || select.with) return [];
  const keys = sourceColumns.filter(column => column.primaryKeyOrdinal > 0).sort((a,b) => a.primaryKeyOrdinal - b.primaryKeyOrdinal);
  const projections = select.columns as { expr: Node; as?: string }[];
  if (!Array.isArray(projections)) return [];
  const result: ColumnInfo[] = [];
  for (const key of keys) {
    const direct = projections.find(item => item.expr?.type === "column_ref" && item.expr.column === key.name && !item.expr.collate);
    const star = projections.some(item => item.expr?.type === "column_ref" && item.expr.column === "*");
    if (!direct && !star) return [];
    result.push({ ...key, name: direct?.as || key.name });
  }
  return result;
}

const integerBounds: Record<string, [bigint, bigint]> = {
  tinyint: [BigInt(0), BigInt(255)], smallint: [BigInt(-32768), BigInt(32767)],
  int: [BigInt(-2147483648), BigInt(2147483647)], integer: [BigInt(-2147483648), BigInt(2147483647)],
  bigint: [BigInt("-9223372036854775808"), BigInt("9223372036854775807")], bit: [BigInt(0), BigInt(1)],
};

// Keep decimals and BIGINTs exact; JavaScript Number would round boundary values.
function numericLiteral(node: Node): { coefficient: bigint; scale: number; text: string } | null {
  if (node.type === "unary_expr" && ["+", "-"].includes(String(node.operator))) {
    const literal = numericLiteral(node.expr as Node);
    return literal && node.operator === "-" ? { ...literal, coefficient: -literal.coefficient, text: `-${literal.text}` } : literal;
  }
  if (!["number", "bigint"].includes(String(node.type))) return null;
  const text = String(node.value).replace(/e[+-]?0+$/i, "");
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!match || !(match[2] || match[3])) throw new Error(`Cannot validate numeric literal ${text}.`);
  let coefficient = BigInt(`${match[1]}${match[2] || "0"}${match[3] || ""}`);
  let scale = (match[3]?.length || 0) - Number(match[4] || 0);
  if (Math.abs(scale) > 400) throw new Error(`Numeric literal ${text} is outside the supported SQL numeric range.`);
  if (scale < 0) { coefficient *= BigInt(10) ** BigInt(-scale); scale = 0; }
  while (scale > 0 && coefficient % BigInt(10) === BigInt(0)) { coefficient /= BigInt(10); scale--; }
  return { coefficient, scale, text };
}

function validateLiteral(column: ColumnInfo, literal: Node) {
  const type = column.dataType.toLowerCase();
  const number = numericLiteral(literal);
  const string = ["single_quote_string", "double_quote_string", "string", "var_string"].includes(String(literal.type));
  const fail = (reason: string): never => { throw new Error(`Invalid filter value ${JSON.stringify(number?.text ?? literal.value)} for column "${column.name}" (${column.dataType}). ${reason}`); };
  if (literal.type === "null") return; // IS NULL is valid regardless of column nullability.
  if (!number && !string && literal.type !== "bool") return; // Expressions are bound by SQL Server.
  if (integerBounds[type]) {
    if (!number || number.scale !== 0) fail("Use a whole-number numeric literal within the column's range; fractional values and implicit string conversions are not allowed.");
    const [min, max] = integerBounds[type];
    if (number.coefficient < min || number.coefficient > max) fail(`Use a value from ${min} to ${max}.`);
  } else if (["decimal", "numeric", "money", "smallmoney"].includes(type)) {
    if (!number) fail("Use a numeric literal, without quotes.");
    const precision = column.precision ?? (type === "money" ? 19 : type === "smallmoney" ? 10 : undefined);
    const scale = column.scale ?? (["money", "smallmoney"].includes(type) ? 4 : undefined);
    if (precision == null || scale == null) fail("Precision and scale metadata are missing. Reload the source table.");
    const digits = number.coefficient.toString().replace("-", "").length;
    if (number.scale > scale || (number.coefficient !== BigInt(0) && Math.max(0, digits - number.scale) > precision - scale)) fail(`The value must fit precision ${precision} and scale ${scale} without rounding.`);
    if (["money", "smallmoney"].includes(type)) {
      const scaled = number.coefficient * BigInt(10) ** BigInt(4 - number.scale);
      const [min, max] = integerBounds[type === "money" ? "bigint" : "int"];
      if (scaled < min || scaled > max) fail("The value exceeds the column's monetary range.");
    }
  } else if (["float", "real"].includes(type)) {
    if (!number) fail("Use a numeric literal, without quotes.");
    const value = Number(number.text);
    if (!Number.isFinite(value) || ((type === "real" || column.precision <= 24) && (!Number.isFinite(Math.fround(value)) || Math.fround(value) === 0 && number.coefficient !== BigInt(0))) || (value === 0 && number.coefficient !== BigInt(0))) fail("The value is outside the floating-point range.");
  } else if (["varchar", "nvarchar", "char", "nchar", "text", "ntext"].includes(type)) {
    if (!string) fail("Use a quoted text literal, rather than an implicit numeric conversion.");
    const value = String(literal.value);
    const length = column.codePage === 65001 && ["varchar", "char"].includes(type) ? new TextEncoder().encode(value).length : value.length;
    if (column.maxLength > 0 && length > column.maxLength) fail(`The value exceeds the column's maximum length of ${column.maxLength}.`);
  } else if (type === "uniqueidentifier") {
    if (!string || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(literal.value))) fail("Use a quoted UUID in the form xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.");
  } else if (["date", "datetime", "datetime2", "smalldatetime", "datetimeoffset", "time"].includes(type)) {
    if (!string) fail("Use a quoted ISO date/time literal appropriate for the column.");
    const value = String(literal.value);
    const date = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]|$)/.exec(value);
    const time = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?$/.exec(type === "time" ? value : value.slice(11));
    if (type !== "time") {
      if (!date) fail("Use an ISO date such as '2026-10-15' or an ISO date/time.");
      const [, y, m, d] = date.map(Number);
      const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
      const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      if (y < 1 || m < 1 || m > 12 || d < 1 || d > days[m - 1]) fail("The calendar date is invalid.");
      const day = value.slice(0, 10);
      if (type === "datetime" && day < "1753-01-01" || type === "smalldatetime" && (day < "1900-01-01" || day > "2079-06-06")) fail("The date is outside the column's range.");
    }
    if (type === "date" && value.length !== 10) fail("A DATE literal must contain only the calendar date.");
    if (type === "time" || value.length > 10) {
      if (!time || Number(time[1]) > 23 || Number(time[2]) > 59 || Number(time[3]) > 59) fail("The time is invalid. Use HH:mm:ss with optional fractional seconds.");
      const precision = column.datetimePrecision ?? (type === "datetime" ? 3 : type === "smalldatetime" ? 0 : 7);
      if ((time[4]?.replace(/0+$/, "").length || 0) > precision) fail(`Fractional seconds exceed the column's precision of ${precision}.`);
      if (time[5] && type !== "datetimeoffset") fail("A timezone offset requires a DATETIMEOFFSET column.");
      if (time[5] && time[5] !== "Z") {
        const hours = Number(time[5].slice(1, 3)), minutes = Number(time[5].slice(4));
        if (hours > 14 || minutes > 59 || hours === 14 && minutes !== 0) fail("The timezone offset is outside the allowed range.");
      }
    }
  } else {
    fail("Filter literal compatibility cannot be established for this datatype. Use a supported datatype or an explicit SQL conversion expression.");
  }
}

export function validateQueryPredicates(query: string, sourceColumns: ColumnInfo[]) {
  // The parser rounds ordinary decimal tokens through parseFloat/toFixed. Its
  // exponent-token path preserves the original text. Use that path ONLY for
  // literal checks, keeping strings, comments and identifiers untouched.
  const exactQuery = query.replace(/--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|\[(?:\]\]|[^\]])*\]|[a-z_@#$][\w@#$]*|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/gi,
    token => /^(?:\d+\.\d*|\.\d+|\d{16,})$/.test(token) ? `${token}e0` : token);
  const ast = parser.astify(exactQuery, options);
  function check(reference: unknown, value: unknown) {
    const ref = reference as Node | undefined, literal = value as Node | undefined;
    if (ref?.type !== "column_ref" || !literal) return;
    const column = sourceColumns.find(column => column.name === ref.column)
      ?? sourceColumns.find(column => column.name.toLowerCase() === String(ref.column).toLowerCase());
    if (!column) throw new Error(`Filter column "${ref.column}" is unavailable. Reload source metadata.`);
    if (literal.type === "expr_list") (literal.value as Node[]).forEach(item => validateLiteral(column, item));
    else validateLiteral(column, literal);
  }
  function visit(value: unknown) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const node = value as Node;
    if (node.type === "binary_expr" && ["=", "!=", "<>", "<", ">", "<=", ">=", "IN", "NOT IN", "BETWEEN", "NOT BETWEEN", "LIKE", "NOT LIKE"].includes(String(node.operator).toUpperCase())) {
      const left = node.left as Node, right = node.right as Node;
      if (left?.type === "null" || right?.type === "null") throw new Error("Use IS NULL or IS NOT NULL instead of comparing a column with NULL.");
      check(left, right); check(right, left);
    }
    // Descend through SELECT wrappers, NOT EXISTS, WHERE, HAVING, and CASE predicates.
    Object.values(node).forEach(visit);
  }
  visit(ast);
}

export function validateQueryResult(resultColumns: ColumnInfo[], targetColumns: ColumnInfo[], targetNames: string[]) {
  if (!resultColumns.length || resultColumns.some(column => !column.name) || new Set(resultColumns.map(column => column.name)).size !== resultColumns.length) throw new Error("Every SELECT result column must have a distinct name or alias before loading.");
  if (new Set(targetNames).size !== targetNames.length) throw new Error("Each target column must appear only once in the query result.");
  if (!targetColumns.length) throw new Error("The target table is unavailable. Reload its metadata in Connect.");
  if (resultColumns.length !== targetNames.length) throw new Error(`SELECT returns ${resultColumns.length} columns but INSERT specifies ${targetNames.length} target columns.`);
  const warnings: string[] = [];
  const mapped: Record<string, { target: string; transformation: string }> = {};
  resultColumns.forEach((column, index) => {
    const target = targetColumns.find(candidate => candidate.name === targetNames[index]);
    if (!target) throw new Error(`Target column "${targetNames[index]}" does not exist.`);
    if (column.name !== target.name) throw new Error(`SELECT column ${index + 1} must be aliased as "${target.name}" to match the INSERT target.`);
    const assessment = assessCompatibility(column, target);
    if (assessment.errors.length || assessment.unknowns.length) throw new Error([...assessment.errors, ...assessment.unknowns].join(" "));
    warnings.push(...assessment.warnings);
    mapped[String(index)] = { target: target.name, transformation: "" };
  });
  const missing = requiredTargetErrors(targetColumns, mapped);
  if (missing.length) throw new Error(missing.join(" "));
  return warnings;
}
