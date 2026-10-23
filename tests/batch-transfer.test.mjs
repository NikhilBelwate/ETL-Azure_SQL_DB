import assert from 'node:assert/strict';
import test from 'node:test';
import { importTypescript } from './load-typescript.mjs';
const { TransferService, batchSelect, insertChunkSize } = await importTypescript(new URL('../src/lib/transfer-service.ts',import.meta.url));
const { queryPrimaryKeyColumns } = await importTypescript(new URL('../src/lib/query-validation.ts',import.meta.url));
const col = (name, extra={}) => ({ name, dataType:'int', nullable:false, ...extra });
function setup(options={}) {
  const count = options.count ?? 2505;
  const sourceColumns = options.sourceColumns ?? [col('Id',{primaryKeyOrdinal:1}),col('Value')];
  const targetColumns = options.targetColumns ?? sourceColumns.map(({primaryKeyOrdinal,...column})=>column);
  const snapshots = new Map(), queries=[], chunks=[], committed=[], events=[];
  const request = { sourceConnection:{database:'source'}, targetConnection:{database:'target'}, plan:{sourceName:'dbo.Source',targetName:'dbo.Target',sourceColumns:[],targetColumns:[],mappings:Object.fromEntries(sourceColumns.filter(c=>targetColumns.some(t=>t.name===c.name)).map(c=>[c.name,{target:c.name,transformation:''}]))} };
  const service = new TransferService(connection=>{
    let pending=[];
    return {
      connect:async()=>{}, close:async()=>{},
      columns:async()=>connection.database==='source'?sourceColumns:targetColumns,
      describe:async()=>options.resultColumns ?? targetColumns,
      select:async(query,parameters=[])=>{
        queries.push({query,parameters});
        if (options.waitForFetch && parameters.length) await options.waitForFetch;
        if (options.fetchFailure && parameters.length) throw Error('fetch failed');
        const limit=Number(/SELECT TOP \((\d+)\)/.exec(query)?.[1]);
        assert.ok(limit>0 && limit<=1001, 'SQL must enforce the fetch limit');
        const after=Number(parameters[0]?.value ?? 0);
        const cursorAliases=[...query.matchAll(/AS \[(_*__etl_cursor_\d+)\]/g)].map(match=>match[1]);
        return Array.from({length:Math.max(0,Math.min(count-after,limit))},(_,index)=>{
          const id=after+index+1;
          const result={};
          if (query.includes('[_query]')) for (const c of options.resultColumns ?? targetColumns) result[c.name]=String(id);
          else sourceColumns.forEach((column,i)=>{result[`__source_${i}`]=String(id);result[`__mapped_${i}`]=String(id);});
          cursorAliases.forEach(name=>{result[name]=String(id);});
          return result;
        });
      },
      begin:async()=>events.push('begin'),
      insert:async()=>{throw Error('row-by-row inserts must not be used');},
      insertBatch:async(table,columns,values)=>{
        chunks.push({columns:columns.length,rows:values.length,parameters:columns.length*values.length});
        if (options.failChunk === chunks.length) throw Error('constraint failure');
        const inserted=values.map(row=>Object.fromEntries(columns.map((name,i)=>[name,row[i]])));
        pending.push(...inserted);return inserted;
      },
      commit:async()=>{events.push('commit');committed.push(...pending);},
      rollback:async()=>{events.push('rollback');pending=[];},
    };
  },()=>100,snapshots);
  return {service,request,sourceColumns,targetColumns,snapshots,queries,chunks,committed,events};
}

test('fetches and inserts 2505 records as 1000/1000/505 without overlap',async()=>{
  const s=setup();
  const ids=[];
  let preview=await s.service.preview(s.request);
  for (const [batchNumber,expected] of [[1,1000],[2,1000],[3,505]]) {
    assert.equal(preview.batchNumber,batchNumber);
    assert.equal(preview.sourceRows.length,expected);
    assert.equal(preview.hasMore,batchNumber<3);
    ids.push(...preview.sourceRows.map(row=>row.Id));
    await s.service.confirm(preview.previewId);
    if (preview.canContinue) preview=await s.service.preview({...s.request,previousPreviewId:preview.previewId});
  }
  assert.equal(new Set(ids).size,2505);
  assert.equal(s.committed.length,2505);
  assert.deepEqual(s.queries.map(q=>q.parameters[0]?.value),[undefined,'1000','2000']);
  assert.ok(s.queries.every(q=>q.query.includes('TOP (1001)') && !q.query.includes('OFFSET')));
  assert.ok(s.chunks.every(chunk=>chunk.parameters<=2000));
});

test('never fetches a lakh of records into a preview; invalid sizes are rejected',async()=>{
  const s=setup({count:100000});
  const preview=await s.service.preview(s.request);
  assert.equal(preview.sourceRows.length,1000);
  assert.equal(preview.mappedRows.length,1000);
  assert.ok(preview.canContinue);
  assert.equal(s.queries.length,1);
  for (const batchSize of [0,-1,1001,100000,1.5,'1000',NaN]) await assert.rejects(s.service.preview({...s.request,batchSize}),/Batch size/);
  assert.equal(s.queries.length,1);
});

test('moving past uninserted records requires an explicit skip and retires their payload',async()=>{
  const s=setup();
  const first=await s.service.preview({...s.request,batchSize:10});
  await assert.rejects(s.service.preview({...s.request,batchSize:10,previousPreviewId:first.previewId}),/explicitly skip/);
  const next=await s.service.preview({...s.request,batchSize:10,previousPreviewId:first.previewId,skipCurrent:true});
  assert.equal(next.sourceRows[0].Id,'11');
  assert.equal(s.snapshots.get(first.previewId).preview,undefined);
  assert.equal(s.snapshots.get(first.previewId).values.length,0);
  assert.equal(s.snapshots.get(first.previewId).targetConnection,null);
  await assert.rejects(s.service.confirm(first.previewId),/cannot be retried/);
  assert.equal(s.committed.length,0);
});

test('continuation retries return the same batch and concurrent requests cannot create duplicates',async()=>{
  let release;
  const options={waitForFetch:new Promise(resolve=>{release=resolve;})};
  const s=setup(options),first=await s.service.preview(s.request);
  const nextRequest={...s.request,previousPreviewId:first.previewId,skipCurrent:true};
  const pending=s.service.preview(nextRequest);
  await assert.rejects(s.service.preview(nextRequest),/busy/);
  await assert.rejects(s.service.confirm(first.previewId),/next batch is being fetched/);
  release();
  const next=await pending;
  assert.equal((await s.service.preview(nextRequest)).previewId,next.previewId);
  assert.equal(s.queries.length,2);
});

test('failed next-batch fetch keeps the current batch available and does not advance the cursor',async()=>{
  const options={fetchFailure:true};
  const s=setup(options),first=await s.service.preview(s.request);
  const nextRequest={...s.request,previousPreviewId:first.previewId,skipCurrent:true};
  await assert.rejects(s.service.preview(nextRequest),/fetch failed/);
  assert.equal(s.snapshots.get(first.previewId).values.length,1000);
  options.fetchFailure=false;
  const next=await s.service.preview(nextRequest);
  assert.equal(next.sourceRows[0].Id,'1001');
});

test('missing primary keys produce a capped preview with an explanation and no unsafe continuation',async()=>{
  const s=setup({sourceColumns:[col('Id'),col('Value')]});
  const first=await s.service.preview(s.request);
  assert.equal(first.sourceRows.length,1000);
  assert.equal(first.hasMore,true);
  assert.equal(first.canContinue,false);
  assert.match(first.batchMessage,/primary key/);
  await assert.rejects(s.service.preview({...s.request,previousPreviewId:first.previewId,skipCurrent:true}),/no safe next batch/);
});

test('continuation rejects changed connections, batch sizes, mappings and primary-key metadata',async()=>{
  const s=setup(),first=await s.service.preview(s.request);
  const next={...s.request,previousPreviewId:first.previewId,skipCurrent:true};
  await assert.rejects(s.service.preview({...next,batchSize:500}),/changed/);
  await assert.rejects(s.service.preview({...next,sourceConnection:{database:'other'}}),/changed/);
  s.sourceColumns[0].dataType='bigint';
  await assert.rejects(s.service.preview(next),/primary key metadata changed|REJECT|range is insufficient/);
});

test('verified query batches preserve filters and follow unchanged aliased primary keys',async()=>{
  const resultColumns=[col('CustomerId'),col('Value')];
  const s=setup({targetColumns:resultColumns,resultColumns});
  const query='SELECT [Id] AS [CustomerId], [Value] FROM [dbo].[Source] WHERE [Id] > 0;';
  const verification=await s.service.verifyQuery({...s.request,query});
  s.request.plan.query={text:query,verificationId:verification.verificationId};
  const first=await s.service.preview(s.request);
  const next=await s.service.preview({...s.request,previousPreviewId:first.previewId,skipCurrent:true});
  assert.equal(first.sourceColumns[0],'CustomerId');
  assert.equal(next.sourceRows[0].CustomerId,'1001');
  assert.match(s.queries[1].query,/WHERE \[Id\] > 0/);
  assert.match(s.queries[1].query,/\[_query\]\.\[CustomerId\] > CONVERT\(int, @after0\)/);
});

test('edited queries cannot page safely after dropping, changing or duplicating their key',()=>{
  const columns=[col('Id',{primaryKeyOrdinal:1}),col('Value')];
  for (const query of [
    'SELECT [Value] FROM [dbo].[Source]',
    'SELECT [Id] + 1 AS [Id] FROM [dbo].[Source]',
    'SELECT [Id] FROM [dbo].[Source] GROUP BY [Id]',
    'SELECT [Id] FROM [dbo].[Source] UNION ALL SELECT [Id] FROM [dbo].[Source]',
  ]) assert.deepEqual(queryPrimaryKeyColumns(query,columns),[],query);
  assert.equal(queryPrimaryKeyColumns('SELECT * FROM [dbo].[Source]',columns)[0].name,'Id');
});

test('composite cursor predicates use parameters and preserve exact values and identifier quoting',()=>{
  const keys=[col('Group]',{primaryKeyOrdinal:1}),col('Id',{dataType:'bigint',primaryKeyOrdinal:2})];
  const batch=batchSelect(['[Value]'],'[dbo].[Source]',keys,1000,['4','9223372036854775806']);
  assert.match(batch.query,/\[Group\]\]\] = CONVERT\(int, @after0\) AND \[Id\] > CONVERT\(bigint, @after1\)/);
  assert.equal(batch.parameters[1].value,'9223372036854775806');
  assert.doesNotMatch(batch.query,/9223372036854775806/);
});

test('wide-row inserts are split below the parameter limit and a failed chunk rolls back the whole batch',async()=>{
  const sourceColumns=Array.from({length:20},(_,i)=>col(i===0?'Id':`Field${i}`,i===0?{primaryKeyOrdinal:1}:{}));
  const s=setup({sourceColumns,count:501});
  const preview=await s.service.preview(s.request);
  await s.service.confirm(preview.previewId);
  assert.deepEqual(s.chunks.map(c=>c.rows),[100,100,100,100,100,1]);
  assert.equal(s.committed.length,501);
  const failed=setup({sourceColumns,count:501,failChunk:2});
  const badPreview=await failed.service.preview(failed.request);
  await assert.rejects(failed.service.confirm(badPreview.previewId),/constraint failure/);
  assert.equal(failed.committed.length,0);
  assert.ok(failed.events.includes('rollback'));
  assert.equal(insertChunkSize(20),100);
});

test('live progress reports real stages and commits only after all chunks succeed',async()=>{
  const sourceColumns=Array.from({length:20},(_,i)=>col(i===0?'Id':`Field${i}`,i===0?{primaryKeyOrdinal:1}:{}));
  const s=setup({sourceColumns,count:250}), fetchEvents=[], insertEvents=[];
  const preview=await s.service.preview(s.request,event=>fetchEvents.push(event));
  assert.deepEqual(fetchEvents.map(e=>e.stage),['validate-request','connect-source','connect-target','validate-schema','fetch-source','map-records','preview-ready']);
  assert.equal(fetchEvents.at(-1).processed,250);
  await s.service.confirm(preview.previewId,event=>insertEvents.push({...event,committedAtEvent:s.committed.length}));
  const chunks=insertEvents.filter(e=>e.stage==='insert-chunk');
  assert.deepEqual(chunks.map(e=>e.processed),[0,100,100,200,200,250]);
  assert.deepEqual(chunks.filter(e=>e.message.startsWith('Writing')).map(e=>[e.chunkStart,e.chunkEnd]),[[1,100],[101,200],[201,250]]);
  assert.ok(chunks.every(e=>e.committedAtEvent===0));
  assert.equal(insertEvents.at(-1).stage,'completed');
  assert.equal(insertEvents.at(-1).committedAtEvent,250);
  const repeat=[];
  await s.service.confirm(preview.previewId,event=>repeat.push(event));
  assert.deepEqual(repeat.map(e=>e.stage),['validate-preview','completed']);
  assert.equal(s.chunks.length,3);
});

test('failure progress identifies the failed chunk and confirms rollback without reporting completion',async()=>{
  const sourceColumns=Array.from({length:20},(_,i)=>col(i===0?'Id':`Field${i}`,i===0?{primaryKeyOrdinal:1}:{}));
  const s=setup({sourceColumns,count:250,failChunk:2}), events=[];
  const preview=await s.service.preview(s.request);
  await assert.rejects(s.service.confirm(preview.previewId,event=>events.push(event)),/constraint failure/);
  const failure=events.find(e=>e.level==='error');
  assert.equal(failure.stage,'insert-chunk');
  assert.equal(failure.chunkStart,101);
  assert.equal(failure.chunkEnd,200);
  assert.equal(failure.processed,100);
  assert.equal(events.at(-1).stage,'rollback');
  assert.equal(events.at(-1).processed,0);
  assert.equal(events.at(-1).level,'success');
  assert.ok(!events.some(e=>e.stage==='completed'));
  assert.equal(s.committed.length,0);
});
