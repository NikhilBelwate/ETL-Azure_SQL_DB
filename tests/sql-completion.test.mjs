import assert from 'node:assert/strict';
import test from 'node:test';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { sql, MSSQL } from '@codemirror/lang-sql';
import { importTypescript } from './load-typescript.mjs';

const { keywordCorrections, sqlCompletionSource } = await importTypescript(new URL('../src/lib/sql-completion.ts', import.meta.url));
const column = (name, dataType = 'int', extra = {}) => ({ name, dataType, nullable: false, ...extra });
const plan = {
  sourceName: 'dbo.SourceData', targetName: 'dbo.TargetData', mappings: {},
  sourceColumns: [column('Id'), column('Name', 'nvarchar', { maxLength: 100 }), column('odd]name'), column('select'), column('form')],
  targetColumns: [column('TargetId', 'bigint'), column('TargetName', 'nvarchar', { maxLength: 200 })],
};
async function complete(doc, { explicit = true, pos = doc.length, metadata = plan } = {}) {
  const state = EditorState.create({ doc, extensions: [sql({ dialect: MSSQL })] });
  return sqlCompletionSource(metadata)(new CompletionContext(state, pos, explicit));
}
const find = (result, name) => result?.options.find(item => item.label === name);

test('offers common SQL keyword spelling corrections including swapped letters', async () => {
  for (const [input, expected] of [['SELETC', 'SELECT'], ['FORM', 'FROM'], ['WHEER', 'WHERE'], ['EXSITS', 'EXISTS']]) {
    assert.ok(keywordCorrections(input, new Set()).includes(expected), input);
    const result = await complete(input, { metadata: { ...plan, sourceColumns: [column('Id')] } });
    assert.equal(find(result, expected)?.apply, expected);
    assert.match(find(result, expected)?.detail, /Correct/);
    assert.equal(result.filter, false);
    assert.equal(result.from, 0);
  }
});

test('does not correct known identifiers, SQL keywords, prefixes, or numbers', () => {
  for (const word of ['form', 'SELECT', 'SEL', '2.8', 'Id']) assert.deepEqual(keywordCorrections(word, new Set(['form', 'id'])), []);
  assert.deepEqual(keywordCorrections('SELETC', new Set()), ['SELECT']);
});

test('offers column datatypes, keywords, and properly quoted identifiers', async () => {
  const result = await complete('SELECT Na');
  assert.equal(find(result, 'Name')?.apply, '[Name]');
  assert.match(find(result, 'Name')?.detail, /nvarchar\(100\)/);
  assert.equal(find(result, 'odd]name')?.apply, '[odd]]name]');
  assert.equal(find(result, 'select')?.apply, '[select]');
  assert.ok(find(result, 'SELECT'));
  assert.equal(find(await complete('FROM dbo.'), 'SourceData')?.apply, '[SourceData]');
  assert.equal(find(await complete('FROM dbo.'), 'TargetData')?.apply, '[TargetData]');
});

test('completes table-qualified and aliased columns', async () => {
  assert.equal(find(await complete('SELECT SourceData.'), 'Name')?.apply, '[Name]');
  const doc = 'SELECT s.Na FROM dbo.SourceData AS s';
  const result = await complete(doc, { pos: doc.indexOf('Na') + 2 });
  assert.equal(find(result, 'Name')?.apply, '[Name]');
  assert.equal(find(result, 'SELECT'), undefined);
  const target = await complete('SELECT TargetData.');
  assert.equal(find(target, 'TargetId')?.apply, '[TargetId]');
});

test('completes inside brackets without adding duplicate closing brackets', async () => {
  const doc = 'SELECT [Na]';
  const result = await complete(doc, { pos: doc.indexOf(']') });
  assert.equal(find(result, '[Name]')?.apply, '[Name]');
  assert.equal(result.to, doc.length);
  assert.equal(find(result, '[odd]name]')?.apply, '[odd]]name]');
});

test('suppresses completions inside strings, comments, and numeric literals', async () => {
  for (const doc of ["SELECT 'SELETC", '-- SELETC', 'SELECT /* SELETC', 'SELECT 2.8']) assert.equal(await complete(doc), null, doc);
});

test('suggestions refresh with selected table metadata and tolerate shared table names', async () => {
  const changed = { ...plan, sourceColumns: [column('NewColumn')] };
  const result = await complete('SELECT Ne', { metadata: changed });
  assert.equal(find(result, 'Name'), undefined);
  assert.equal(find(result, 'NewColumn')?.apply, '[NewColumn]');
  const shared = { ...plan, targetName: plan.sourceName };
  const both = await complete('SELECT SourceData.', { metadata: shared });
  assert.ok(find(both, 'Id'));
  assert.ok(find(both, 'TargetId'));
});
