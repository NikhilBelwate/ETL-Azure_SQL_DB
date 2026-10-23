import type { ColumnInfo } from "./azureSql";
import { compatibilityPolicy, type CompatibilityPolicy, type CompatibilityStatus } from "./compatibility-policy";

export interface CompatibilityResult {
  status: CompatibilityStatus;
  errors: string[];
  warnings: string[];
  unknowns: string[];
  notes: string[];
}
const stringTypes = ["char", "varchar", "nchar", "nvarchar", "text", "ntext", "clob", "nclob"];
const integerBits: Record<string, number> = { tinyint: 8, smallint: 16, int: 32, bigint: 64 };
const numericTypes = ["decimal", "numeric", "money", "smallmoney"];
const floatTypes = ["float", "real", "double", "double precision"];
const dateTypes = ["date", "datetime", "datetime2", "smalldatetime", "time", "datetimeoffset", "timestamp", "timestamptz"];
const binaryTypes = ["binary", "varbinary", "image", "blob", "rowversion"];
const booleanTypes = ["bit", "boolean", "bool"];
export const normalizedType = (column: ColumnInfo) => {
  if (!column || typeof column.dataType !== "string" || !column.dataType.trim()) throw new Error("Column datatype is missing.");
  const type = column.dataType.trim().toLowerCase();
  return type === "integer" ? "int" : type;
};
const dialect = (column: ColumnInfo) => column.dialect || "sqlserver";
const isInteger = (column: ColumnInfo) => Object.prototype.hasOwnProperty.call(integerBits, normalizedType(column));
const known = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);
const pow10 = (n: number) => BigInt(10) ** BigInt(n);
const label = (column: ColumnInfo) => `"${column.name}" (${definition(column)})`;
const pair = (s: ColumnInfo, t: ColumnInfo) => `Source ${label(s)} → target ${label(t)}.`;
const isUnicode = (type: string) => ["nchar", "nvarchar", "ntext", "nclob"].includes(type);
const fixedString = (type: string) => ["char", "nchar"].includes(type);
const isSqlRowversion = (column: ColumnInfo) => normalizedType(column) === "rowversion" || (normalizedType(column) === "timestamp" && dialect(column) === "sqlserver");
const decimalShape = (column: ColumnInfo) => known(column.precision) && column.precision >= 1 && column.precision <= 38 && known(column.scale) && column.scale >= 0 && column.scale <= column.precision;

export function definition(column: ColumnInfo): string {
  if (!column || typeof column.dataType !== "string" || !column.dataType.trim()) return "Unknown datatype — reload tables";
  const type = normalizedType(column);
  let result = type;
  if (["char", "varchar", "nchar", "nvarchar", "binary", "varbinary"].includes(type)) result += `(${column.maxLength === -1 ? "MAX" : known(column.maxLength) ? column.maxLength : "?"})`;
  if (["decimal", "numeric"].includes(type)) result += `(${known(column.precision) ? column.precision : "?"},${known(column.scale) ? column.scale : "?"})`;
  if (["time", "datetime2", "datetimeoffset"].includes(type)) result += `(${known(column.datetimePrecision) ? column.datetimePrecision : "?"})`;
  if (type === "float") result += `(${known(column.precision) ? column.precision : "?"})`;
  if (column.unsigned) result += " unsigned";
  return column.userDefinedType ? `${column.userDefinedType} [${result}]` : result;
}
interface Domain { min: bigint; max: bigint; scale: number; }
function integerDomain(column: ColumnInfo): Domain | null {
  if (column.integerRange) {
    const min = BigInt(column.integerRange.min), max = BigInt(column.integerRange.max);
    return min <= max ? { min, max, scale: 0 } : null;
  }
  const type = normalizedType(column), bits = integerBits[type];
  if (!bits || dialect(column) === "custom") return null;
  if (dialect(column) === "postgresql" && type === "tinyint") return null;
  const unsigned = column.unsigned ?? (type === "tinyint" && dialect(column) === "sqlserver");
  const power = BigInt(2) ** BigInt(unsigned ? bits : bits - 1);
  return { min: unsigned ? BigInt(0) : -power, max: power - BigInt(1), scale: 0 };
}
function exactDomain(column: ColumnInfo): Domain | null {
  const type = normalizedType(column);
  if (isInteger(column)) return integerDomain(column);
  if (["decimal", "numeric"].includes(type)) {
    if (!decimalShape(column)) return null;
    const max = pow10(column.precision) - BigInt(1);
    return { min: -max, max, scale: column.scale };
  }
  if (dialect(column) !== "sqlserver") return null;
  if (type === "money") return { min: BigInt("-9223372036854775808"), max: BigInt("9223372036854775807"), scale: 4 };
  if (type === "smallmoney") return { min: BigInt("-2147483648"), max: BigInt("2147483647"), scale: 4 };
  return null;
}
function scaledNumber(value: bigint, scale: number): string {
  const negative = value < BigInt(0), digits = (negative ? -value : value).toString().padStart(scale + 1, "0");
  return `${negative ? "-" : ""}${scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits}`;
}
const domainText = (domain: Domain) => `${scaledNumber(domain.min, domain.scale)} through ${scaledNumber(domain.max, domain.scale)}`;
function floatBits(column: ColumnInfo): number | null {
  const type = normalizedType(column);
  if (type === "real" && dialect(column) === "sqlserver") return 24;
  if (type === "double precision" && dialect(column) === "sqlserver") return 53;
  if (type === "double" && dialect(column) !== "sqlserver" && dialect(column) !== "custom") return 53;
  if (type !== "float" || !known(column.precision)) return null;
  if (dialect(column) === "sqlserver" && column.precision >= 1 && column.precision <= 53) return column.precision <= 24 ? 24 : 53;
  return null;
}
function capacity(column: ColumnInfo): number | null {
  const type = normalizedType(column);
  if (isSqlRowversion(column)) return 8;
  if (["text", "image"].includes(type) && dialect(column) === "sqlserver") return 2147483647;
  if (type === "ntext" && dialect(column) === "sqlserver") return 1073741823;
  if (column.maxLength === -1) return isUnicode(type) ? 1073741823 : 2147483647;
  return known(column.maxLength) && column.maxLength > 0 ? column.maxLength : null;
}
interface Temporal { min: string; max: string; time: boolean; date: boolean; zone: boolean; precision: number | null; tick: "decimal" | "datetime"; }
function temporal(column: ColumnInfo): Temporal | null {
  if (dialect(column) !== "sqlserver") return null;
  const type = normalizedType(column), precision = column.datetimePrecision;
  const fractional = known(precision) && precision >= 0 && precision <= 7 ? precision : null;
  if (type === "date") return {min:"0001-01-01",max:"9999-12-31",date:true,time:false,zone:false,precision:0,tick:"decimal"};
  if (type === "datetime") return {min:"1753-01-01",max:"9999-12-31",date:true,time:true,zone:false,precision:3,tick:"datetime"};
  if (type === "smalldatetime") return {min:"1900-01-01",max:"2079-06-06",date:true,time:true,zone:false,precision:0,tick:"decimal"};
  if (type === "datetime2" || type === "datetimeoffset") return {min:"0001-01-01",max:"9999-12-31",date:true,time:true,zone:type === "datetimeoffset",precision:fractional,tick:"decimal"};
  if (type === "time") return {min:"",max:"",date:false,time:true,zone:false,precision:fractional,tick:"decimal"};
  return null;
}

// SQL Server definitions: https://learn.microsoft.com/sql/t-sql/data-types/int-bigint-smallint-and-tinyint-transact-sql
// Decimal domains: https://learn.microsoft.com/sql/t-sql/data-types/decimal-and-numeric-transact-sql
export function assessCompatibility(source: ColumnInfo, target: ColumnInfo, policy: CompatibilityPolicy = compatibilityPolicy): CompatibilityResult {
  const errors: string[] = [], warnings: string[] = [], unknowns: string[] = [], notes: string[] = [];
  const reject = (message: string) => errors.push(`${pair(source, target)} ${message}`);
  const warn = (message: string) => warnings.push(`${pair(source, target)} ${message}`);
  const unknown = (message: string) => unknowns.push(`${pair(source, target)} ${message} Compatibility is UNKNOWN; explicit review and a server-owned compatibility rule are required before loading.`);
  try {
    const s = normalizedType(source), t = normalizedType(target);
    const custom = policy.customRules.find(rule => rule.sourceType.toLowerCase() === (source.userDefinedType || s).toLowerCase() && rule.targetType.toLowerCase() === (target.userDefinedType || t).toLowerCase() && (!rule.matches || rule.matches(source, target)));
    if (target.identity || target.computed || isSqlRowversion(target)) {
      reject("The target is generated by SQL Server. Leave this target column unmapped.");
    } else if (custom) {
      ({ACCEPT:notes,WARN:warnings,REJECT:errors,UNKNOWN:unknowns}[custom.status]).push(`${pair(source,target)} ${custom.message}`);
    } else if (source.userDefinedType || target.userDefinedType) {
      unknown("A user-defined type may have additional constraints. Review its complete domain instead of assuming its base datatype is sufficient.");
    } else if (stringTypes.includes(s) && stringTypes.includes(t)) {
      const sc = capacity(source), tc = capacity(target);
      const su = isUnicode(s), tu = isUnicode(t);
      let required = sc;
      if (sc === null || tc === null) unknown("String capacity metadata is missing. Reload both tables to compare their declared capacities.");
      else {
        if (su && !tu) {
          if (target.codePage !== 65001) reject("The target encoding cannot represent the full Unicode source domain. Use an nchar/nvarchar target or a reviewed UTF-8 conversion policy.");
          else { required = sc * 3; warn(`Unicode-to-UTF-8 conversion can expand storage (up to ${required} bytes for ${sc} UTF-16 code units). Review Unicode validity and encoding semantics.`); }
        } else if (!su && !tu) {
          if (!source.codePage || !target.codePage) unknown("The source or target code page is missing. Reload the encoding/collation metadata before accepting this string conversion.");
          else if (source.codePage !== target.codePage) unknown(`Code pages differ (${source.codePage} → ${target.codePage}). Character repertoire and expansion cannot be proven safe; configure a reviewed encoding rule.`);
        }
        if (tc < required) reject(`String capacity is insufficient: source requires up to ${required} ${tu ? "UTF-16 code units" : "bytes"}, target holds ${tc}. Longer values can be truncated. Increase the target capacity.`);
        else notes.push(`String capacity is sufficient (${sc} → ${tc}); the target can hold the source length.`);
        if (fixedString(t) && (!fixedString(s) || sc !== tc || su !== tu)) warn("The target is fixed-length and may add trailing spaces. Review padding and equality semantics before accepting this mapping.");
        if (source.collation && target.collation && source.collation !== target.collation && (su && tu || source.codePage === target.codePage)) warn("Collations differ. Values may fit, but sorting, case sensitivity, or comparison semantics can change.");
      }
    } else if ((isInteger(source) || numericTypes.includes(s)) && (isInteger(target) || numericTypes.includes(t))) {
      const sd = exactDomain(source), td = exactDomain(target);
      if (!sd || !td) unknown("Numeric range, precision, scale, or signedness metadata is missing or unsupported. Reload the metadata or configure an explicit numeric range.");
      else {
        if (td.scale < sd.scale) reject(`Fractional precision would be lost: source scale ${sd.scale}, target scale ${td.scale}. Increase the target scale to at least ${sd.scale} to avoid rounding.`);
        const scale = Math.max(sd.scale, td.scale), sm = pow10(scale - sd.scale), tm = pow10(scale - td.scale);
        if (td.min * tm > sd.min * sm || td.max * tm < sd.max * sm) reject(`Numeric range is insufficient. Source range: ${domainText(sd)}; target range: ${domainText(td)}. The target must include every source value, including negative values and integer digits.`);
        else if (td.scale >= sd.scale) notes.push(`The target numeric range contains the full source range and preserves all ${sd.scale} fractional digits.`);
      }
    } else if (floatTypes.includes(s) && floatTypes.includes(t)) {
      const sb = floatBits(source), tb = floatBits(target);
      if (sb === null || tb === null) unknown("Floating-point precision and range are database-specific. Provide the source/target dialect and mantissa precision; FLOAT and DOUBLE are not assumed interchangeable.");
      else if (tb < sb) reject(`Floating-point narrowing (${sb} → ${tb} significand bits) can lose precision, overflow large values, and underflow small values. Use an equal-or-wider floating-point target.`);
      else notes.push(`The target floating-point format preserves the source precision and range (${sb} → ${tb} significand bits).`);
    } else if ((isInteger(source) || numericTypes.includes(s)) && floatTypes.includes(t)) {
      const sd = exactDomain(source), bits = floatBits(target);
      if (!sd || !bits) unknown("The exact numeric domain or target floating-point format is unknown.");
      else if (sd.scale === 0 && sd.min >= -(BigInt(2) ** BigInt(bits)) && sd.max <= BigInt(2) ** BigInt(bits)) notes.push("Every source integer is exactly representable by the target floating-point significand and range.");
      else warn("Exact-to-floating-point conversion is potentially lossy. Decimal fractions or large integers may be rounded; small values may underflow. Review precision requirements before proceeding.");
    } else if (floatTypes.includes(s) && (isInteger(target) || numericTypes.includes(t))) {
      reject("The complete floating-point range and fractional precision cannot fit this exact numeric target. Overflow, rounding, or underflow can occur; use an explicit reviewed conversion policy.");
    } else if ((dateTypes.includes(s) && !isSqlRowversion(source)) && (dateTypes.includes(t) && !isSqlRowversion(target))) {
      const sd = temporal(source), td = temporal(target);
      if (!sd || !td) unknown("Temporal ranges and TIMESTAMP meanings vary by database system. Configure a dialect-specific date/time rule.");
      else {
        if (sd.date && !td.date) reject("The target has no date component. Converting to TIME would discard the source date.");
        if (sd.time && !td.time) reject("The target has no time component. Converting to DATE would discard source time information.");
        if (!sd.date && td.date) warn("A date must be added to each time-only value. Define and review the intended reference date.");
        if (sd.date && td.date && (td.min > sd.min || td.max < sd.max)) reject(`The target date range (${td.min} through ${td.max}) does not cover the source (${sd.min} through ${sd.max}). Some source dates would be out of range.`);
        if (sd.zone && !td.zone) warn("Timezone-aware → timezone-naive conversion drops the offset and may change the intended instant. Define and review a UTC/offset conversion policy before loading.");
        if (!sd.zone && td.zone) warn("The source has no timezone. Assigning an offset requires a reviewed timezone policy; the intended instant cannot be inferred.");
        if (sd.precision === null || td.precision === null) unknown("Fractional-second precision metadata is missing. Reload both table definitions.");
        else if (sd.time && td.time) {
          if (td.precision < sd.precision) reject(`Fractional-second precision would decrease (${sd.precision} → ${td.precision}). Increase the target temporal precision to preserve source values.`);
          if (s !== t && (s === "datetime" || t === "datetime" && s !== "smalldatetime")) warn("SQL DATETIME uses 1/300-second rounding rather than a decimal fractional-second grid. Review rounding even when declared precision appears sufficient.");
          if (t === "smalldatetime" && s !== "smalldatetime") reject("SMALLDATETIME has minute precision. Seconds and fractional seconds would be rounded or lost.");
        }
        if (!errors.length && !unknowns.length && !warnings.length) notes.push("The target preserves the source date range, time components, timezone semantics, and fractional-second precision.");
      }
    } else if (booleanTypes.includes(s) && booleanTypes.includes(t)) {
      notes.push("Both types represent false and true; SQL Server BIT stores false=0 and true=1.");
    } else if (booleanTypes.includes(s) && (isInteger(target) || numericTypes.includes(t))) {
      const td = exactDomain(target);
      if (!td) unknown("The target numeric range is unknown; the documented false=0, true=1 mapping cannot be verified.");
      else if (td.min > BigInt(0) || td.max < pow10(td.scale)) reject("The numeric target cannot represent both false=0 and true=1.");
      else notes.push("Documented boolean conversion: false=0 and true=1. The target numeric domain includes both values.");
    } else if ((isInteger(source) || numericTypes.includes(s) || floatTypes.includes(s)) && booleanTypes.includes(t)) {
      warn("Numeric → boolean collapses distinct values: SQL Server converts zero to false and nonzero values to true. Review this explicit conversion rule before loading; the original numbers are not preserved.");
    } else if ((binaryTypes.includes(s) || isSqlRowversion(source)) && binaryTypes.includes(t)) {
      const sc = capacity(source), tc = capacity(target);
      if (sc === null || tc === null) unknown("Binary byte capacity is missing. Reload the metadata or configure the binary format.");
      else {
        if (tc < sc) reject(`Binary capacity is insufficient (${sc} → ${tc} bytes). Bytes may be truncated; increase the target byte capacity.`);
        else notes.push(`The target binary byte capacity covers the source (${sc} → ${tc}).`);
        if (t === "binary" && (s !== "binary" || sc !== tc)) warn("The fixed-length BINARY target can add zero bytes. Review padding and byte-level equality semantics.");
      }
    } else if (["uniqueidentifier", "uuid"].includes(s) && ["uniqueidentifier", "uuid"].includes(t)) {
      notes.push("Both UUID types represent the same 128-bit identifier domain.");
    } else if (s === "enum" && t === "enum") {
      if (!source.enumValues?.length || !target.enumValues?.length) unknown("ENUM allowed-value sets are missing. Provide both sets or configure a reviewed ENUM rule.");
      else {
        const missing = source.enumValues.filter(value => !target.enumValues.includes(value));
        if (missing.length) reject(`The target ENUM omits source values: ${missing.map(value=>JSON.stringify(value)).join(", ")}. Extend its allowed set.`);
        else {
          notes.push("Every source ENUM value is allowed by the target ENUM.");
          if (source.enumValues.some((value,index)=>target.enumValues.indexOf(value)!==index)) warn("ENUM ordinal ordering changes. Review sorting and ordinal-based application behavior even though all named values fit.");
        }
      }
    } else if (s === "json" && t === "json" && dialect(source) === dialect(target)) {
      notes.push("Both native JSON types share the same database dialect and JSON value domain. Separate table constraints still apply.");
    } else if (s === "xml" && t === "xml") {
      if (target.xmlSchema === null) notes.push("The untyped XML target can store source XML documents and fragments; table constraints still apply.");
      else unknown("The target XML schema restrictions have not been proven to include the complete source XML domain. Configure a reviewed XML-schema compatibility rule.");
    } else if (stringTypes.includes(s) && binaryTypes.includes(t) || binaryTypes.includes(s) && stringTypes.includes(t)) {
      unknown("Text/binary conversion needs an explicit encoding and decoding policy; byte capacity alone does not establish compatibility.");
    } else {
      unknown("No built-in safe conversion is defined for this type pair. Review ENUM, JSON/XML constraints, spatial reference systems, UDTs, or other database-specific semantics and configure a reviewed rule.");
    }
    if (typeof source.nullable !== "boolean" || typeof target.nullable !== "boolean") unknown("Nullability metadata is missing. Reload both definitions before claiming that every source value can be stored.");
    else if (source.nullable && !target.nullable) reject("The source allows NULL but the target is NOT NULL. Use a non-nullable source or implement a validated NULL replacement policy. A target DEFAULT does not replace an explicitly mapped NULL.");
  } catch {
    unknowns.push(`Compatibility metadata for source "${source?.name || "unknown"}" and target "${target?.name || "unknown"}" is missing or invalid. Reload both table definitions and review the mapping before loading.`);
  }
  return {status:errors.length ? "REJECT" : unknowns.length ? "UNKNOWN" : warnings.length ? "WARN" : "ACCEPT",errors,warnings,unknowns,notes};
}
