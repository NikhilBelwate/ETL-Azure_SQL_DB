import type { ColumnInfo } from "./azureSql";
import { assessCompatibility, definition, normalizedType, type CompatibilityResult } from "./type-compatibility";

export interface ColumnMapping { target: string; transformation: string; reviewedWarnings?: string[]; }
export type ColumnMappingValues = Record<string,ColumnMapping>;
export type MappingValidation = CompatibilityResult;
export const columnDefinition = definition;
const textTypes = ["varchar","char","nvarchar","nchar","text","ntext","clob","nclob"];
const integerTypes = ["int","bigint","smallint","tinyint"];
const numberTypes = [...integerTypes,"decimal","numeric","money","smallmoney","float","real","double","double precision"];
const arithmetic = /^value\s*([*\/+%\-])\s*(value|-?(?:\d+(?:\.\d+)?|\.\d+))$/;
const empty = (): MappingValidation => ({status:"ACCEPT",errors:[],warnings:[],unknowns:[],notes:[]});

export function transformationHelp(column: ColumnInfo): string {
  const type = normalizedType(column);
  if (textTypes.includes(type)) return "Text: value, value.Trim(), value.ToUpper(), or value.ToLower().";
  if (numberTypes.includes(type)) return "Numeric: value or one operation, such as value*2, value+10, value/2, or value-value.";
  if (["date","datetime","datetime2","smalldatetime","datetimeoffset","time"].includes(type)) return "Date/time: use value or leave empty to copy. Date functions and arithmetic are not supported.";
  if (["bit","boolean","bool"].includes(type)) return "Boolean: use value or leave empty to copy. Boolean-to-numeric uses false=0 and true=1.";
  return `${type}: use value or leave empty to copy. Other transformations are not supported.`;
}

export function validateMapping(source: ColumnInfo, mapping: ColumnMapping, targets: ColumnInfo[], mappings: ColumnMappingValues): MappingValidation {
  try {
    if (!mapping.target) return empty();
    const target = targets.find(column=>column.name===mapping.target);
    if (!target) return {...empty(),status:"REJECT",errors:[`Target column "${mapping.target}" no longer exists. Reload its table and select another target.`]};
    const result = assessCompatibility(source,target);
    const {errors,warnings} = result;
    const duplicateSources = Object.entries(mappings).filter(([name,other])=>name!==source.name && other.target===mapping.target).map(([name])=>`"${name}"`);
    if (duplicateSources.length) errors.push(`Target "${target.name}" is also mapped from ${duplicateSources.join(", ")}. Each target can receive only one source column; choose another target or leave the extra source unmapped.`);
    const sourceType = normalizedType(source), targetType = normalizedType(target);
    const expression = mapping.transformation.trim();
    if (expression && expression!=="value") {
      if (textTypes.includes(sourceType)) {
        if (!/^value\.(Trim|ToUpper|ToLower)\(\)$/.test(expression)) errors.push(`Invalid text formula for "${source.name}" (${source.dataType}). ${transformationHelp(source)}`);
      } else if (numberTypes.includes(sourceType)) {
        const match = arithmetic.exec(expression);
        if (!match) errors.push(`Invalid numeric formula for "${source.name}" (${source.dataType}). ${transformationHelp(source)} Text methods, SQL statements, and multiple operations are not supported.`);
        else {
          const [,operator,operand] = match;
          const number = operand==="value" ? null : Number(operand);
          if (number!==null && !Number.isFinite(number)) errors.push("The numeric operand is too large. Enter a finite number.");
          if (["/","%"].includes(operator) && number===0) errors.push(`Cannot ${operator==="/" ? "divide" : "calculate a remainder"} by zero. Use a nonzero divisor.`);
          if (["/","%"].includes(operator) && operand==="value") warnings.push(`Formula for "${source.name}" can divide by a source value of zero. Review the actual rows before accepting this formula.`);
          if (operator==="%" && [sourceType,targetType].some(type=>["float","real","double","double precision"].includes(type))) errors.push("Remainder (%) is not supported for float or real columns. Use another operation.");
          if (integerTypes.includes(targetType) && number!==null && !Number.isInteger(number)) errors.push(`A fractional operand can produce a non-integer result for target "${target.name}" (${target.dataType}). Use an integer operand or select a decimal target.`);
          if (operator==="/" && integerTypes.includes(sourceType) && (operand==="value" || Number.isInteger(number))) warnings.push("SQL integer division truncates the fractional part. Review this formula or use an explicitly defined decimal conversion.");
          if (["+","-","*"].includes(operator)) warnings.push(`Formula for "${source.name}" changes its numeric domain. SQL arithmetic can overflow before target conversion, even when the target is wider. Review the actual source values and resulting target range.`);
        }
      } else errors.push(`Unsupported formula for "${source.name}" (${source.dataType}). ${transformationHelp(source)}`);
    }
    result.status = errors.length ? "REJECT" : result.unknowns.length ? "UNKNOWN" : warnings.length ? "WARN" : "ACCEPT";
    return result;
  } catch {
    return {...empty(),status:"UNKNOWN",unknowns:[`Validation could not be completed for source "${source?.name || "unknown"}" → target "${mapping?.target || "not selected"}". Reload both tables and review the missing metadata or formula. Loading is blocked until compatibility can be established.`]};
  }
}

export function mappingBlockingMessages(validation: MappingValidation, mapping: ColumnMapping): string[] {
  const reviewed = Array.isArray(mapping?.reviewedWarnings) ? mapping.reviewedWarnings : [];
  return [...validation.errors,...validation.unknowns,...validation.warnings.filter(message=>!reviewed.includes(message)).map(message=>`Warning review required: ${message}`)];
}

export function requiredTargetErrors(targetColumns: ColumnInfo[], mappings: ColumnMappingValues): string[] {
  const selected = Object.values(mappings).map(mapping=>mapping.target);
  return targetColumns.filter(column=>!selected.includes(column.name) && !column.nullable && !column.identity && !column.computed && !column.hasDefault && !(normalizedType(column)==="rowversion" || normalizedType(column)==="timestamp" && (!column.dialect || column.dialect==="sqlserver"))).map(column=>`Required target column "${column.name}" (${definition(column)}) has no DEFAULT and no source mapping. Map it or define a valid target default. Defaults are applied only to omitted columns, not explicitly mapped NULL values.`);
}

const quote = (name:string) => `[${name.replaceAll("]","]]")}]`;
export function sqlExpression(expression:string,column:string):string {
  const source = quote(column), value = expression.trim();
  if (!value || value==="value") return source;
  if (value==="value.Trim()") return `TRIM(${source})`;
  if (value==="value.ToUpper()") return `UPPER(${source})`;
  if (value==="value.ToLower()") return `LOWER(${source})`;
  const match = arithmetic.exec(value);
  if (!match) throw new Error("The transformation is unsupported. Correct the highlighted formula and try again.");
  const [,operator,operand] = match;
  return `${source} ${operator} ${operand==="value" ? source : `(${operand})`}`;
}

export function generateQueryPreview(sourceName:string,targetName:string,sourceColumns:ColumnInfo[],targetColumns:ColumnInfo[],mappings:ColumnMappingValues):string {
  const selected = sourceColumns.filter(column=>mappings[column.name]?.target);
  if (!selected.length) throw new Error("Select at least one target column before generating a query preview.");
  const issues = selected.flatMap(column=>mappingBlockingMessages(validateMapping(column,mappings[column.name],targetColumns,mappings),mappings[column.name]));
  issues.push(...requiredTargetErrors(targetColumns,mappings));
  if (issues.length) throw new Error(`Query preview was not generated. ${[...new Set(issues)].join(" ")}`);
  const sourceTable = sourceName.split(".").map(quote).join("."), targetTable = targetName.split(".").map(quote).join(".");
  const expressions = selected.map(column=>`${sqlExpression(mappings[column.name].transformation,column.name)} AS ${quote(mappings[column.name].target)}`).join(", ");
  const targetNames = selected.map(column=>quote(mappings[column.name].target)).join(", ");
  return `-- Preview only; no data is transferred.\nSELECT ${expressions} FROM ${sourceTable};\n\n-- Execute only where both tables are accessible.\nINSERT INTO ${targetTable} (${targetNames})\nSELECT ${expressions} FROM ${sourceTable};`;
}
