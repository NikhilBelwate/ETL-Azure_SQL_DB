import assert from 'node:assert/strict';
import test from 'node:test';
import { importTypescript } from './load-typescript.mjs';
const { TransferService, tableIdentifier, preservedSqlValue, insertionParameter, queryResultSelect } = await importTypescript(new URL('../src/lib/transfer-service.ts',import.meta.url));
const { validateMapping } = await importTypescript(new URL('../src/lib/mapping-validation.ts',import.meta.url));
const column = (name, extra = {}) => ({ name, dataType: 'int', nullable: false, ...extra });
const connection = database => ({ server: 'test', database, userName: 'test', password: 'test' });
function setup(options = {}) {
  const log = [], committed = [], pending = [];
  let now = 100;
  const rows = [{ __source_0: 3, __mapped_0: 6 }, { __source_0: 5, __mapped_0: 10 }];
  const gateways = [];
  const service = new TransferService(details => {
    const side = details.database;
    const gateway = {
      connect: async () => { log.push(`${side}:connect`); },
      close: async () => { log.push(`${side}:close`); },
      columns: async () => side === 'source' ? options.sourceColumns || [column('amount')] : options.targetColumns || [column('id', { identity: true }), column('total'), ...(options.extraColumns || [])],
      describe: async query => { log.push(`describe:${query}`); if (options.describeFailure) throw Error('invalid SQL'); return options.resultColumns || [column('total')]; },
      select: async query => { log.push(query); if (options.fetchFailure) throw Error('select failure'); return options.empty ? [] : options.queryRows || rows; },
      begin: async () => { log.push('begin'); },
      insert: async (table, columns, values) => {
        log.push('insert');
        if (options.waitForInsert) await options.waitForInsert;
        if (options.insertFailure && pending.length) throw Error('constraint failure');
        const row = { id: pending.length + 1, total: values[0] };
        pending.push(row);
        return [row];
      },
      commit: async () => { log.push('commit'); if (options.commitFailure) throw Error('connection lost'); committed.push(...pending); },
      rollback: async () => { log.push('rollback'); pending.length = 0; if (options.rollbackFailure) throw Error('rollback failed'); },
    };
    gateways.push(gateway);
    return gateway;
  }, () => now);
  const request = { sourceConnection: connection('source'), targetConnection: connection('target'), plan: { sourceName: 'dbo.Source', targetName: 'dbo.Target', sourceColumns: [], targetColumns: [], mappings: { amount: { target: 'total', transformation: 'value*2' } } } };
  request.plan.mappings.amount.reviewedWarnings = validateMapping(column('amount'),request.plan.mappings.amount,options.targetColumns || [column('total')],request.plan.mappings).warnings;
  return { service, request, rows, log, committed, pending, advance: () => { now += 16 * 60 * 1000; } };
}

test('preview executes SELECT only and preserves the fetched batch for confirmation', async () => {
  const s = setup();
  const preview = await s.service.preview(s.request);
  assert.equal(s.log.includes('insert'), false);
  assert.equal(s.log.includes('begin'), false);
  assert.deepEqual(preview.sourceRows, [{amount:3},{amount:5}]);
  assert.deepEqual(preview.mappedRows, [{total:6},{total:10}]);
  assert.match(preview.selectQuery, /\[amount\] \* \(2\)/);
  s.rows[0].__mapped_0 = 999;
  const result = await s.service.confirm(preview.previewId);
  assert.deepEqual(result.insertedRows, [{id:1,total:6},{id:2,total:10}]);
  assert.deepEqual(s.committed, result.insertedRows);
  assert.equal(s.log.filter(x => x === 'commit').length, 1);
  assert.equal(s.log.filter(x => x.startsWith('SELECT')).length, 1);
});

test('repeated confirmation returns committed output without a second insertion', async () => {
  const s = setup(), preview = await s.service.preview(s.request);
  const first = await s.service.confirm(preview.previewId);
  const second = await s.service.confirm(preview.previewId);
  assert.deepEqual(first, second);
  assert.equal(s.log.filter(x => x === 'insert').length, 2);
});

test('a failed row rolls back the entire batch and prevents unsafe retry', async () => {
  const s = setup({ insertFailure: true }), preview = await s.service.preview(s.request);
  await assert.rejects(s.service.confirm(preview.previewId), /constraint failure/);
  assert.deepEqual(s.committed, []);
  assert.deepEqual(s.pending, []);
  assert.ok(s.log.includes('rollback'));
  await assert.rejects(s.service.confirm(preview.previewId), /cannot be retried/);
});

test('a concurrent confirmation cannot start another transaction', async () => {
  let release;
  const waitForInsert = new Promise(resolve => { release = resolve; });
  const s = setup({ waitForInsert }), preview = await s.service.preview(s.request);
  const first = s.service.confirm(preview.previewId);
  await assert.rejects(s.service.confirm(preview.previewId), /already being inserted/);
  release();
  await first;
  assert.equal(s.log.filter(x => x === 'begin').length, 1);
});

test('expired, missing, and empty snapshots cannot insert records', async () => {
  const s = setup(), preview = await s.service.preview(s.request);
  s.advance();
  await assert.rejects(s.service.confirm(preview.previewId), /expired/);
  await assert.rejects(s.service.confirm('made-up-token'), /expired/);
  const empty = setup({empty:true}), emptyPreview = await empty.service.preview(empty.request);
  await assert.rejects(empty.service.confirm(emptyPreview.previewId), /no records/);
  assert.equal(s.log.includes('insert'), false);
});

test('server validation uses real metadata and rejects missing and generated targets', async () => {
  const s = setup();
  s.request.plan.mappings.amount = { target: 'id', transformation:'value' };
  await assert.rejects(s.service.preview(s.request), /generated by SQL Server/);
  const required = setup({extraColumns:[column('required')]});
  await assert.rejects(required.service.preview(required.request), /Required target column "required"/);
  const invalid = setup();
  invalid.request.plan.mappings.amount.transformation = 'value/0';
  await assert.rejects(invalid.service.preview(invalid.request), /divide by zero/);
  assert.equal(invalid.log.includes('insert'), false);
});

test('source fetch failure closes both database pools without writing', async () => {
  const s = setup({fetchFailure:true});
  await assert.rejects(s.service.preview(s.request), /select failure/);
  assert.ok(s.log.includes('source:close'));
  assert.ok(s.log.includes('target:close'));
  assert.equal(s.log.includes('begin'), false);
});

test('server rejects unsafe narrowing using database metadata instead of submitted metadata', async () => {
  const s = setup({sourceColumns:[column('amount',{dataType:'nvarchar',maxLength:100})],targetColumns:[column('total',{dataType:'nvarchar',maxLength:50})]});
  s.request.plan.mappings.amount.transformation = 'value';
  s.request.plan.sourceColumns = [column('amount',{dataType:'varchar',maxLength:100})];
  await assert.rejects(s.service.preview(s.request), /capacity is insufficient/);
  assert.equal(s.log.some(x=>x.startsWith('SELECT')),false);
  assert.equal(s.log.includes('insert'),false);
});

test('schema changes after preview are rejected before the insert transaction begins', async () => {
  const options = {};
  const s = setup(options), preview = await s.service.preview(s.request);
  options.targetColumns = [column('total',{dataType:'smallint'})];
  await assert.rejects(s.service.confirm(preview.previewId), /target schema no longer matches.*range is insufficient/);
  assert.equal(s.log.includes('begin'),false);
  assert.deepEqual(s.committed,[]);
});

test('commit and rollback uncertainty never reports success or permits a retry', async () => {
  const s = setup({commitFailure:true,rollbackFailure:true}), preview = await s.service.preview(s.request);
  await assert.rejects(s.service.confirm(preview.previewId), /outcome could not be verified/);
  await assert.rejects(s.service.confirm(preview.previewId), /cannot be retried/);
});

test('table identifiers are quoted and never accepted as raw SQL', () => {
  assert.equal(tableIdentifier('dbo.Target]; DROP TABLE x;--'), '[dbo].[Target]]; DROP TABLE x;--]');
  assert.throws(() => tableIdentifier('database.dbo.table'), /schema-qualified/);
});

test('SQL source values retain decimal precision and temporal fractional digits through serialization',()=>{
  assert.match(preservedSqlValue('[Amount]',column('Amount',{dataType:'decimal'})),/CONVERT\(nvarchar\(128\)/);
  assert.match(preservedSqlValue('[When]',column('When',{dataType:'datetimeoffset'})),/127/);
  assert.match(preservedSqlValue('[Rate]',column('Rate',{dataType:'float'})),/, 3\)/);
  assert.equal(preservedSqlValue('[Bytes]',column('Bytes',{dataType:'varbinary'})),'[Bytes]');
  assert.equal(insertionParameter('@v',column('s',{dataType:'decimal'}),column('t',{dataType:'bit'})),'CONVERT(bit, CONVERT(float, @v))');
  assert.equal(insertionParameter('@v',column('s',{dataType:'bit'}),column('t',{dataType:'int'})),'@v');
});

test('unreviewed warning and unknown mappings are blocked by the server before SELECT',async()=>{
  for(const [sourceColumns,targetColumns] of [
    [[column('amount',{dataType:'varchar',maxLength:100,codePage:1252})],[column('total',{dataType:'char',maxLength:100,codePage:1252})]],
    [[column('amount',{dataType:'geometry'})],[column('total',{dataType:'geometry'})]],
  ]) {
    const s=setup({sourceColumns,targetColumns});
    s.request.plan.mappings.amount={target:'total',transformation:'value'};
    await assert.rejects(s.service.preview(s.request),/Warning review required|UNKNOWN/);
    assert.equal(s.log.some(x=>x.startsWith('SELECT')),false);
  }
});

const editedQuery = 'SELECT [amount] * 2 AS [total] FROM [dbo].[Source] WHERE [amount] = 3;';
async function verifyEdited(s, query = editedQuery) {
  const verification = await s.service.verifyQuery({ ...s.request, query });
  s.request.plan.query = { text: query, verificationId: verification.verificationId };
  return verification;
}

test('verification checks metadata without executing the query or writing data', async () => {
  const s = setup();
  const verification = await verifyEdited(s);
  assert.ok(verification.verificationId);
  assert.ok(verification.expiresAt > 100);
  assert.equal(s.log.some(item => item.startsWith('SELECT')), false);
  assert.equal(s.log.includes('begin'), false);
  assert.ok(s.log.includes('source:close'));
  assert.ok(s.log.includes('target:close'));
});

test('verified edited SELECT drives Source Records and inserts exactly its reviewed results', async () => {
  const s = setup({ queryRows: [{ total: '6' }] });
  await verifyEdited(s);
  const preview = await s.service.preview(s.request);
  assert.deepEqual(preview.sourceColumns, ['total']);
  assert.deepEqual(preview.sourceRows, [{ total: '6' }]);
  assert.deepEqual(preview.mappedRows, [{ total: '6' }]);
  assert.match(preview.selectQuery, /WHERE \[amount\] = 3/);
  assert.equal(s.log.includes('insert'), false);
  const result = await s.service.confirm(preview.previewId);
  assert.deepEqual(result.insertedRows, [{ id: 1, total: '6' }]);
  assert.equal(s.log.filter(item => item.startsWith('SELECT')).length, 1);
});

test('full preview batches execute only the verified SELECT, never the INSERT text', async () => {
  const s = setup({ queryRows: [{ total: 6 }] });
  const select = editedQuery.slice(0, -1);
  await verifyEdited(s, `${select}; INSERT INTO [dbo].[Target] ([total]) ${select};`);
  await s.service.preview(s.request);
  const executed = s.log.find(item => item.startsWith('SELECT'));
  assert.match(executed, /WHERE \[amount\] = 3/);
  assert.doesNotMatch(executed, /INSERT/);
  assert.equal(s.log.includes('begin'), false);
});

test('unverified, changed, forged, and expired edited queries never fall back to loading all rows', async () => {
  for (const mutate of [
    s => { s.request.plan.query.verificationId = undefined; },
    s => { s.request.plan.query.verificationId = 'forged'; },
    s => { s.request.plan.query.text = editedQuery.replace('= 3', '= 5'); },
    s => { s.request.sourceConnection.database = 'other'; },
    s => { s.request.targetConnection.database = 'other'; },
    s => { s.request.plan.mappings.amount.transformation = 'value'; },
    s => { s.advance(); },
  ]) {
    const s = setup();
    await verifyEdited(s);
    mutate(s);
    await assert.rejects(s.service.preview(s.request), /unverified|expired/);
    assert.equal(s.log.some(item => item.startsWith('SELECT')), false);
  }
});

test('invalid nested filter values cannot obtain verification for data loading', async () => {
  const s = setup();
  await assert.rejects(verifyEdited(s, editedQuery.replace('= 3', '= 2.8')), /whole-number/);
  assert.equal(s.log.some(item => item.startsWith('SELECT')), false);
  assert.equal(s.request.plan.query, undefined);
});

test('schema compatibility is rechecked before fetching edited query results and before insertion', async () => {
  const options = { queryRows: [{ total: 6 }] };
  const s = setup(options);
  await verifyEdited(s);
  options.targetColumns = [column('total', { dataType: 'smallint' })];
  await assert.rejects(s.service.preview(s.request), /range is insufficient/);
  assert.equal(s.log.some(item => item.startsWith('SELECT')), false);
  options.targetColumns = [column('total')];
  const preview = await s.service.preview(s.request);
  options.targetColumns = [column('total', { dataType: 'smallint' })];
  await assert.rejects(s.service.confirm(preview.previewId), /target schema no longer matches/);
  assert.equal(s.log.includes('begin'), false);
});

test('edited results preserve numeric precision, ORDER BY, and empty result sets', async () => {
  const exact = '2.000000000000000001';
  const decimal = column('total', { dataType: 'decimal', precision: 19, scale: 18 });
  const s = setup({ resultColumns: [decimal], targetColumns: [decimal], queryRows: [{ total: exact }] });
  const query = `SELECT CAST(${exact} AS decimal(19,18)) AS [total] FROM [dbo].[Source] ORDER BY [amount];`;
  await verifyEdited(s, query);
  const preview = await s.service.preview(s.request);
  assert.ok(preview.selectQuery.includes(exact));
  assert.match(preview.selectQuery, /ORDER BY \[amount\]\s+OFFSET 0 ROWS/);
  assert.deepEqual(preview.sourceRows, [{ total: exact }]);
  const empty = setup({ empty: true });
  await verifyEdited(empty);
  const emptyPreview = await empty.service.preview(empty.request);
  assert.deepEqual(emptyPreview.sourceRows, []);
  await assert.rejects(empty.service.confirm(emptyPreview.previewId), /no records/);
  assert.doesNotMatch(queryResultSelect('SELECT TOP (1) [total] FROM [dbo].[Source] ORDER BY [total]', [column('total')]), /OFFSET/);
});

test('commit and rollback failures remain uncertain in live progress',async()=>{
  const committing=setup({commitFailure:true}),commitEvents=[];
  const preview=await committing.service.preview(committing.request);
  await assert.rejects(committing.service.confirm(preview.previewId,event=>commitEvents.push(event)),/commit outcome could not be verified/);
  assert.equal(commitEvents.find(e=>e.level==='error').stage,'commit');
  assert.ok(commitEvents.some(e=>e.stage==='rollback' && e.level==='warning' && /uncertain/.test(e.message)));
  assert.ok(!commitEvents.some(e=>e.stage==='completed'));
  const rollback=setup({insertFailure:true,rollbackFailure:true}),rollbackEvents=[];
  const bad=await rollback.service.preview(rollback.request);
  await assert.rejects(rollback.service.confirm(bad.previewId,event=>rollbackEvents.push(event)),/outcome could not be verified/);
  assert.equal(rollbackEvents.at(-1).stage,'rollback');
  assert.equal(rollbackEvents.at(-1).level,'error');
  assert.ok(!rollbackEvents.some(e=>e.stage==='completed'));
});
