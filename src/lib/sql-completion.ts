import { type Completion, type CompletionContext, type CompletionResult, type CompletionSource } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { MSSQL, keywordCompletionSource, schemaCompletionSource, type SQLConfig, type SQLNamespace } from "@codemirror/lang-sql";
import { columnDefinition } from "./mapping-validation";
import type { TransferPlan } from "./transfer-types";

const commonKeywords = "SELECT FROM WHERE INSERT INTO VALUES UPDATE SET DELETE JOIN INNER LEFT RIGHT FULL OUTER ON AS AND OR NOT EXISTS IN BETWEEN LIKE IS NULL DISTINCT GROUP BY HAVING ORDER ASC DESC UNION ALL CASE WHEN THEN ELSE END TOP CAST CONVERT COALESCE NULLIF".split(" ");
const quote = (name: string) => `[${name.replaceAll("]", "]]")}]`;

// Damerau-Levenshtein distance also recognizes swapped letters (SELETC).
function spellingDistance(a: string, b: string) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
  }
  return rows[a.length][b.length];
}

export function keywordCorrections(word: string, identifiers: ReadonlySet<string>): string[] {
  const upper = word.toUpperCase();
  if (!/^[a-z]{3,20}$/i.test(word) || identifiers.has(word.toLowerCase()) || commonKeywords.includes(upper)) return [];
  // Prefixes are handled by ordinary autocomplete, not presented as misspellings.
  if (commonKeywords.some(keyword => keyword.startsWith(upper))) return [];
  const matches = commonKeywords.map(keyword => ({ keyword, distance: spellingDistance(upper, keyword) }))
    .filter(({ distance }) => distance <= (word.length >= 5 ? 2 : 1))
    .sort((a, b) => a.distance - b.distance || a.keyword.localeCompare(b.keyword));
  return matches.filter(match => match.distance === matches[0]?.distance).slice(0, 3).map(({ keyword }) => keyword);
}

export function sqlCompletionConfig(plan: TransferPlan): SQLConfig {
  const schemas: Record<string, Record<string, { self: Completion; children: Completion[] }>> = Object.create(null);
  for (const [name, columns, role] of [[plan.sourceName, plan.sourceColumns, "Source"], [plan.targetName, plan.targetColumns, "Target"]] as const) {
    const [schema, table] = name.split(".");
    if (!schema || !table) continue;
    const tables = schemas[schema] ??= Object.create(null);
    const entry = tables[table] ??= { self: { label: table, type: "type", detail: `${role} table`, info: name, apply: quote(table) }, children: [] };
    for (const column of columns) {
      const detail = `${columnDefinition(column)} · ${role.toLowerCase()}`;
      const previous = entry.children.find(item => item.label === column.name);
      if (previous) previous.detail += ` / ${detail}`;
      else entry.children.push({ label: column.name, type: "property", detail, info: `${name}.${column.name}${column.nullable ? " · nullable" : " · NOT NULL"}`, apply: quote(column.name) });
    }
  }
  const schema: Record<string, SQLNamespace> = Object.create(null);
  for (const [name, tables] of Object.entries(schemas)) schema[name] = { self: { label: name, type: "namespace", apply: quote(name) }, children: tables };
  const [defaultSchema, defaultTable] = plan.sourceName.split(".");
  return { dialect: MSSQL, schema, defaultSchema, defaultTable, upperCaseKeywords: true };
}

export function sqlCompletionSource(plan: TransferPlan): CompletionSource {
  const schemaSource = schemaCompletionSource(sqlCompletionConfig(plan));
  const keywordSource = keywordCompletionSource(MSSQL, true);
  const identifiers = new Set([plan.sourceName, plan.targetName].flatMap(name => name.split(".")).concat([...plan.sourceColumns, ...plan.targetColumns].map(column => column.name)).map(name => name.toLowerCase()));
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const node = syntaxTree(context.state).resolveInner(context.pos, -1);
    if (["String", "LineComment", "BlockComment", "Number", "Bytes", "Bits"].includes(node.name)) return null;
    const [schema, keywords] = await Promise.all([schemaSource(context), keywordSource(context)]);
    if (schema) {
      const opening = context.state.sliceDoc(schema.from, schema.from + 1);
      schema.options = schema.options.map(option => {
        const name = ["[", '"', "`"].includes(opening) ? option.label.slice(1, -1) : option.label;
        return { ...option, apply: quote(name) };
      });
    }
    const word = context.matchBefore(/[a-zA-Z_][a-zA-Z_0-9]*$/);
    const qualified = word && /[.\["@]$/.test(context.state.sliceDoc(Math.max(0, word.from - 1), word.from));
    if (qualified || node.name === "QuotedIdentifier") return schema;
    const corrections = word && node.name !== "QuotedIdentifier" && !qualified ? keywordCorrections(word.text, identifiers) : [];
    if (corrections.length) {
      const ordinary = [schema, keywords].flatMap(result => result && result.from === word.from ? result.options : [])
        .filter(option => option.label.toLowerCase().startsWith(word.text.toLowerCase()));
      return { from: word.from, filter: false, options: [
        ...corrections.map(label => ({ label, type: "keyword", detail: `Correct ${word.text} → ${label}`, apply: label })), ...ordinary,
      ] };
    }
    // Qualified and bracketed names use the SQL provider's replacement range.
    if (schema && (!keywords || schema.from !== keywords.from)) return schema;
    if (!schema) return keywords;
    return { ...schema, options: [...schema.options, ...(keywords?.options ?? [])] };
  };
}
