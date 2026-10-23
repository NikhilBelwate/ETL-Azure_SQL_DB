import assert from 'node:assert/strict';
import test from 'node:test';
import { importTypescript } from './load-typescript.mjs';

const { parseQueryPreview, validateQueryPredicates, validateQueryResult } = await importTypescript(new URL('../src/lib/query-validation.ts', import.meta.url));
const { generateQueryPreview } = await importTypescript(new URL('../src/lib/mapping-validation.ts', import.meta.url));
const col = (name, dataType = 'int', extra = {}) => ({ name, dataType, nullable: false, ...extra });
const batch = (expression = '[id]', target = 'id') => `SELECT ${expression} AS [${target}] FROM [dbo].[source]; INSERT INTO [dbo].[target] ([${target}]) SELECT ${expression} AS [${target}] FROM [dbo].[source];`;
const parse = query => parseQueryPreview(query, 'dbo.source', 'dbo.target');

test('accepts the generated preview, including comments and transformed expressions', () => {
  const query = generateQueryPreview('dbo.source', 'dbo.target', [col('id')], [col('id')], { id: { target: 'id', transformation: '' } });
  assert.deepEqual(parse(query).targetNames, ['id']);
  assert.match(parse(batch('[id] + (1)')).selectQuery, /SELECT/);
  assert.match(parse(batch('CAST([id] AS BIGINT)')).selectQuery, /BIGINT/);
});

test('rejects blank, malformed, oversized and unsupported batches', () => {
  for (const query of ['', ' ', 'SELECT FROM;', 'x'.repeat(50001), 'DELETE FROM dbo.source;', `${batch()} DROP TABLE dbo.target;`]) {
    assert.throws(() => parse(query));
  }
  assert.equal(parse('SELECT [id] FROM [dbo].[source];').targetNames, null);
});

test('rejects changed tables, inconsistent SELECTs, duplicates, SELECT INTO, and VALUES', () => {
  assert.throws(() => parse(batch().replace('[dbo].[target]', '[dbo].[other]')), /selected table/);
  assert.throws(() => parse(batch().replaceAll('[dbo].[source]', '[dbo].[other]')), /selected source/);
  assert.throws(() => parse(batch().replace('SELECT [id]', 'SELECT [id] + 1')), /must match/);
  assert.throws(() => parse(batch().replace('([id]) SELECT', '([id], [id]) SELECT')), /only once/);
  assert.throws(() => parse(batch().replace('AS [id] FROM', 'AS [id] INTO [dbo].[copy] FROM')), /INTO|syntax/);
  assert.throws(() => parse('SELECT [id] AS [id] FROM [dbo].[source]; INSERT INTO [dbo].[target] ([id]) VALUES (1);'), /must use a SELECT/);
});

test('checks target counts, aliases, required columns and generated columns', () => {
  assert.deepEqual(validateQueryResult([col('id')], [col('id', 'bigint')], ['id']), []);
  assert.throws(() => validateQueryResult([col('id')], [col('id')], ['id', 'other']), /returns 1 columns/);
  assert.throws(() => validateQueryResult([col('id')], [col('other')], ['id']), /does not exist/);
  assert.throws(() => validateQueryResult([col('other')], [col('id')], ['id']), /aliased/);
  assert.throws(() => validateQueryResult([col('id')], [col('id'), col('required')], ['id']), /Required target/);
  assert.throws(() => validateQueryResult([col('id')], [col('id', 'int', { identity: true })], ['id']), /generated/);
});

test('rejects type narrowing and nullable results for required targets', () => {
  assert.throws(() => validateQueryResult([col('id', 'bigint')], [col('id')], ['id']), /range|overflow/i);
  assert.throws(() => validateQueryResult([col('id', 'int', { nullable: true })], [col('id')], ['id']), /NULL/);
});

test('returns conversion warnings for successful checks', () => {
  const warnings = validateQueryResult([col('id')], [col('id', 'bit')], ['id']);
  assert.ok(warnings.length > 0);
});

test('rejects literal zero divisors before contacting SQL Server', () => {
  assert.throws(() => parse(batch('[id] / (0)')), /divides by zero/);
  assert.throws(() => parse(batch('[id] % 0')), /divides by zero/);
  assert.doesNotThrow(() => parse(batch('[id] / NULLIF([id], 0)')));
});

const sourceColumns = [col('Id'), col('Name', 'nvarchar', { maxLength: 20 }), col('Amount', 'decimal', { precision: 6, scale: 2 })];
const predicate = (where, columns = sourceColumns) => validateQueryPredicates(`SELECT [Id] FROM [dbo].[source] WHERE ${where}`, columns);

test('regression: rejects fractional integer literal inside the user NOT EXISTS query', () => {
  const query = `SELECT [Id], [Name]
    FROM [dbo].[TestData_New]
    WHERE [Id] = 2 AND NOT EXISTS (
      SELECT 1 FROM [dbo].[TestData_New] WHERE [Id] = 2.8
    );`;
  const parsed = parseQueryPreview(query, 'dbo.TestData_New', 'dbo.target');
  assert.throws(() => validateQueryPredicates(parsed.selectQuery, sourceColumns), /2\.8.*Id.*int.*whole-number/);
  assert.doesNotThrow(() => validateQueryPredicates(parsed.selectQuery.replace('2.8', '2'), sourceColumns));
});

test('checks nested and correlated predicates, reversed comparisons, IN and BETWEEN', () => {
  for (const where of ['[Id] = 2.8', '2.8 = [Id]', '[Id] IN (1, 2.8)', '[Id] NOT IN (1, 2.8)', '[Id] BETWEEN 1 AND 2.8', '[Id] NOT BETWEEN -2.8 AND 2', '[Id] > -2.8',
    'NOT EXISTS (SELECT 1 FROM [dbo].[source] s WHERE s.[Id] = 2.8)',
    '[Id] IN (SELECT [Id] FROM [dbo].[source] WHERE [Id] = 2.8)',
    'EXISTS (SELECT 1 FROM [dbo].[source] s WHERE EXISTS (SELECT 1 FROM [dbo].[source] t WHERE t.[Id] = 2.8))']) {
    assert.throws(() => predicate(where), /whole-number/, where);
  }
  for (const where of ['[Id] = 2', '[Id] = 2.0', '[Id] = 2e1', '[Id] = -2', '[Id] IN (1, 2)', '[Id] BETWEEN -2 AND 2', '[Id] IS NULL', '[Id] = [Id]']) assert.doesNotThrow(() => predicate(where), where);
});

test('validates exact integer ranges without floating point rounding', () => {
  for (const [type, accepted, rejected] of [
    ['tinyint', ['0', '255'], ['-1', '256', '2.8']],
    ['smallint', ['-32768', '32767'], ['-32769', '32768']],
    ['int', ['-2147483648', '2147483647'], ['-2147483649', '2147483648', '2.000000000000000001']],
    ['bigint', ['-9223372036854775808', '9223372036854775807'], ['-9223372036854775809', '9223372036854775808']],
    ['bit', ['0', '1'], ['2', '-1', '0.5']],
  ]) {
    const columns = [col('Id', type)];
    for (const value of accepted) assert.doesNotThrow(() => predicate(`[Id] = ${value}`, columns), `${type}: ${value}`);
    for (const value of rejected) assert.throws(() => predicate(`[Id] = ${value}`, columns), /Invalid filter value/, `${type}: ${value}`);
  }
});

test('checks each column datatype rather than banning all decimals', () => {
  assert.doesNotThrow(() => predicate('[Amount] = 2.8'));
  assert.doesNotThrow(() => predicate('[Amount] BETWEEN -9999.99 AND 9999.99'));
  assert.throws(() => predicate('[Amount] = 2.888'), /precision 6 and scale 2/);
  assert.throws(() => predicate('[Amount] = 10000'), /precision 6 and scale 2/);
  assert.doesNotThrow(() => predicate('[Id] = 0', [col('Id', 'decimal', { precision: 2, scale: 2 })]));
  assert.throws(() => predicate("[Id] = '2.8'"), /implicit string/);
  assert.throws(() => predicate('[Name] = 2.8'), /quoted text/);
  assert.throws(() => predicate("[Name] = '123456789012345678901'"), /maximum length/);
  assert.doesNotThrow(() => predicate("[Name] = 'Alice'"));
});

test('checks date, UUID, and floating point literals and NULL comparisons', () => {
  const dateColumns = [col('Id', 'date')];
  assert.doesNotThrow(() => predicate("[Id] = '2024-02-29'", dateColumns));
  assert.throws(() => predicate("[Id] = '2025-02-29'", dateColumns), /calendar date/);
  assert.throws(() => predicate('[Id] = 2.8', dateColumns), /quoted ISO/);
  assert.throws(() => predicate("[Id] = 'invalid'", [col('Id', 'uniqueidentifier')]), /UUID/);
  assert.doesNotThrow(() => predicate('[Id] = 2.8', [col('Id', 'float', { precision: 53 })]));
  assert.throws(() => predicate('[Id] = 1e39', [col('Id', 'real')]), /floating-point/);
  assert.throws(() => predicate('[Id] = NULL'), /IS NULL/);
});

test('literal checks preserve strings, identifiers, comments, casts and exact decimals', () => {
  assert.doesNotThrow(() => predicate("[Name] = '2.8 is text' -- [Id] = 2.8\n AND [Id] = 2"));
  assert.doesNotThrow(() => predicate("[Name] = 'Alice''s 2.8' /* [Id] = 2.8 */ AND [Id] = 2"));
  assert.doesNotThrow(() => predicate('[Amount] = CAST(2.8 AS decimal(6,2))'));
  assert.doesNotThrow(() => predicate('[Amount] = 0.12', [col('Amount', 'decimal', { precision: 2, scale: 2 })]));
  assert.throws(() => predicate('[Id] = -2.000000000000000001'), /whole-number/);
  assert.throws(() => predicate('[Amount] = 0.120000000000000001'), /precision/);
  const query = `${batch()} -- trailing comment`;
  assert.doesNotThrow(() => validateQueryPredicates(query, [col('id')]));
  assert.throws(() => validateQueryPredicates(batch().replaceAll('FROM [dbo].[source]', 'FROM [dbo].[source] WHERE [id] = 2.8'), [col('id')]), /whole-number/);
});

test('preserves the original SELECT text and strips only the outer statement separator', () => {
  for (const expression of ["'text;with;semicolons'", "CAST(2.000000000000000001 AS decimal(19,18))", '[odd;column]']) {
    const select = `SELECT ${expression} AS [id] FROM [dbo].[source]`;
    const query = `${select}; INSERT INTO [dbo].[target] ([id]) ${select};`;
    assert.equal(parse(query).selectQuery, select);
  }
  const select = '-- comment ;\nSELECT [id] FROM [dbo].[source] /* comment ; */';
  assert.equal(parse(`${select};`).selectQuery, select);
});
