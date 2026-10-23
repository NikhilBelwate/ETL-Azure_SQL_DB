import assert from 'node:assert/strict';
import test from 'node:test';
import {importTypescript} from './load-typescript.mjs';
const {transferResponse}=await importTypescript(new URL('../src/lib/transfer-stream.ts',import.meta.url));
const {readTransferResponse,TransferRequestError}=await importTypescript(new URL('../src/lib/transfer-client.ts',import.meta.url));
const {transferErrorResponse}=await importTypescript(new URL('../src/lib/sql-transfer.ts',import.meta.url));
const {TransferError}=await importTypescript(new URL('../src/lib/transfer-service.ts',import.meta.url));
const request=()=>new Request('http://localhost/test',{headers:{accept:'application/x-ndjson'}});
const failure=(error,stage)=>Response.json({error:error.message,stage},{status:500});

test('server streams a stage before the operation completes and client receives final result',async()=>{
  let finish;
  const waiting=new Promise(resolve=>{finish=resolve;});
  const response=await transferResponse(request(),async progress=>{
    progress({stage:'connect-source',level:'info',message:'Connecting'});
    await waiting;
    progress({stage:'preview-ready',level:'success',message:'Ready'});
    return {count:1000};
  },failure);
  const events=[];
  const result=readTransferResponse(response,event=>events.push(event));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(events[0].stage,'connect-source');
  finish();
  assert.deepEqual(await result,{count:1000});
  assert.equal(events.at(-1).stage,'preview-ready');
});

test('stream error preserves the failing stage after a successful rollback',async()=>{
  const response=await transferResponse(request(),async progress=>{
    progress({stage:'insert-chunk',level:'error',message:'Rows 101-200 failed'});
    progress({stage:'rollback',level:'success',message:'Rolled back'});
    throw Error('constraint failed');
  },failure);
  await assert.rejects(readTransferResponse(response,()=>{}),error=>error instanceof TransferRequestError && error.failure.stage==='insert-chunk');
});

test('disconnecting the console does not cancel a server transaction or its cleanup',async()=>{
  let finish, completed=false;
  const waiting=new Promise(resolve=>{finish=resolve;});
  const response=await transferResponse(request(),async progress=>{
    progress({stage:'commit',level:'info',message:'Committing'});
    await waiting;
    completed=true;
    progress({stage:'completed',level:'success',message:'Committed'});
    return {count:1};
  },failure);
  await response.body.cancel();
  finish();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(completed,true);
});

test('non-streaming clients retain JSON results and HTTP error statuses',async()=>{
  const req=new Request('http://localhost/test');
  const response=await transferResponse(req,async()=>({count:4}),failure);
  assert.deepEqual(await readTransferResponse(response,()=>assert.fail()),{count:4});
  const bad=await transferResponse(req,async()=>{throw Error('bad input');},failure);
  assert.equal(bad.status,500);
  await assert.rejects(readTransferResponse(bad,()=>{}),/bad input/);
});

test('client handles fragmented UTF-8 and rejects truncated streams without claiming success',async()=>{
  const encoded=new TextEncoder().encode(JSON.stringify({type:'progress',event:{stage:'fetch-source',level:'info',message:'Source → target'}})+'\n'+JSON.stringify({type:'result',data:{count:2}}));
  const response=new Response(new ReadableStream({start(controller){for(const byte of encoded)controller.enqueue(Uint8Array.of(byte));controller.close();}}),{headers:{'content-type':'application/x-ndjson'}});
  const events=[];
  assert.deepEqual(await readTransferResponse(response,event=>events.push(event)),{count:2});
  assert.equal(events[0].message,'Source → target');
  const incomplete=new Response('{"type":"progress","event":{"stage":"commit"}}\n',{headers:{'content-type':'application/x-ndjson'}});
  await assert.rejects(readTransferResponse(incomplete,()=>{}),/before a final result/);
});

test('SQL exception diagnostics include number, line, procedure and redacted database message',async()=>{
  const error=Object.assign(Error('unsafe outer message Password=outer-secret'),{name:'RequestError',code:'EREQUEST',number:2627,originalError:{info:{lineNumber:7,procName:'InsertRows',message:"Duplicate key. Password=hidden; pwd='quoted secret'; UID=admin"}}});
  const data=await transferErrorResponse(error,'insert','insert-chunk').json();
  assert.equal(data.details.line,7);
  assert.equal(data.details.number,2627);
  assert.equal(data.details.procedure,'InsertRows');
  assert.equal(data.stage,'insert-chunk');
  assert.doesNotMatch(JSON.stringify(data),/hidden|quoted secret|outer-secret|UID=admin/);
  assert.match(data.details.message,/redacted/);
  assert.doesNotMatch(JSON.stringify(data),/stack/);
});

test('login diagnostics omit raw credential-bearing messages; uncertain commit retains original error code',async()=>{
  const login=Object.assign(Error('Password=secret'),{code:'ELOGIN',originalError:{info:{message:'Password=secret'}}});
  assert.doesNotMatch(JSON.stringify(await transferErrorResponse(login,'fetch','connect-source').json()),/secret/);
  const cause=Object.assign(Error('connection lost'),{code:'ESOCKET'});
  const uncertain=new TransferError('The commit outcome could not be verified.',500,cause);
  const data=await transferErrorResponse(uncertain,'insert','commit').json();
  assert.equal(data.details.code,'ESOCKET');
  assert.match(data.error,/could not be verified/);
  assert.doesNotMatch(data.error,/rolled back/);
});
