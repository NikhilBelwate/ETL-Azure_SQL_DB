import assert from 'node:assert/strict';
import test from 'node:test';
import { importTypescript } from './load-typescript.mjs';

const { automaticColumnMappings, sameTableName } = await importTypescript(new URL('../src/lib/automatic-mappings.ts', import.meta.url));
const { validateMapping, mappingBlockingMessages, requiredTargetErrors, generateQueryPreview } = await importTypescript(new URL('../src/lib/mapping-validation.ts', import.meta.url));
const column = (name, dataType = 'int', extra = {}) => ({ name, dataType, nullable: false, ...extra });

test('only same table names trigger automatic matching, including different schemas', () => {
  assert.equal(sameTableName('dbo.Customers', 'dbo.Customers'), true);
  assert.equal(sameTableName('dbo.Customers', 'sales.Customers'), true);
  for (const [source, target] of [['dbo.Customers', 'dbo.CustomerArchive'], ['dbo.Customers', 'dbo.customers'], ['', ''], ['dbo.', 'dbo.']]) {
    assert.equal(sameTableName(source, target), false);
    assert.deepEqual(automaticColumnMappings(source, target, [column('Id')], [column('Id')]), {});
  }
});

test('matches exact column names and leaves unmatched columns unmapped', () => {
  const source = [column('Id'), column('Name'), column('SourceOnly'), column('lowercase')];
  const target = [column('Name'), column('Id'), column('TargetOnly'), column('Lowercase')];
  const mappings = automaticColumnMappings('dbo.Customers', 'dbo.Customers', source, target);
  assert.deepEqual(mappings, { Id: { target: 'Id', transformation: '' }, Name: { target: 'Name', transformation: '' } });
  assert.equal(new Set(Object.values(mappings).map(mapping => mapping.target)).size, 2);
});

test('compatible automatically mapped columns use existing ACCEPT results and query generation', () => {
  const source = [column('Id')], target = [column('Id', 'bigint')];
  const mappings = automaticColumnMappings('dbo.Customers', 'dbo.Customers', source, target);
  assert.equal(validateMapping(source[0], mappings.Id, target, mappings).status, 'ACCEPT');
  assert.match(generateQueryPreview('dbo.Customers', 'dbo.Customers', source, target, mappings), /SELECT \[Id\] AS \[Id\]/);
});

test('incompatible same-name columns remain selected so existing errors are visible', () => {
  const source = [column('Id', 'bigint')], target = [column('Id')];
  const mappings = automaticColumnMappings('dbo.Customers', 'dbo.Customers', source, target);
  assert.equal(mappings.Id.target, 'Id');
  assert.equal(validateMapping(source[0], mappings.Id, target, mappings).status, 'REJECT');
  assert.throws(() => generateQueryPreview('dbo.Customers', 'dbo.Customers', source, target, mappings), /range is insufficient/);
});

test('automatic matching never acknowledges conversion warnings or bypasses required targets', () => {
  const source = [column('Id')], target = [column('Id', 'bit'), column('Required')];
  const mappings = automaticColumnMappings('dbo.Customers', 'dbo.Customers', source, target);
  const validation = validateMapping(source[0], mappings.Id, target, mappings);
  assert.equal(validation.status, 'WARN');
  assert.equal(mappings.Id.reviewedWarnings, undefined);
  assert.ok(mappingBlockingMessages(validation, mappings.Id).length);
  assert.match(requiredTargetErrors(target, mappings)[0], /Required/);
});

test('generated target columns still show existing rejection and input metadata is unchanged', () => {
  const source = [column('Id')], target = [column('Id', 'int', { identity: true })];
  const original = JSON.stringify([source, target]);
  const mappings = automaticColumnMappings('dbo.Customers', 'dbo.Customers', source, target);
  assert.equal(validateMapping(source[0], mappings.Id, target, mappings).status, 'REJECT');
  assert.equal(JSON.stringify([source, target]), original);
  assert.deepEqual(automaticColumnMappings('dbo.Customers', 'dbo.Customers', [], target), {});
});
