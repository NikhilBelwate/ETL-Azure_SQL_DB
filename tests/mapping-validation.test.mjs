import assert from 'node:assert/strict';
import test from 'node:test';
import {importTypescript} from './load-typescript.mjs';
const {assessCompatibility} = await importTypescript(new URL('../src/lib/type-compatibility.ts',import.meta.url));
const {validateMapping,mappingBlockingMessages,generateQueryPreview,requiredTargetErrors,sqlExpression} = await importTypescript(new URL('../src/lib/mapping-validation.ts',import.meta.url));
const col = (name,dataType,extra={})=>({name,dataType,nullable:false,maxLength:100,precision:18,scale:2,datetimePrecision:7,codePage:1252,collation:'Latin1_General_100_CI_AS',xmlSchema:null,dialect:'sqlserver',...extra});
const assess = (s,t,se={},te={})=>assessCompatibility(col('Source',s,se),col('Target',t,te));
const cases = [
 ['varchar widening','varchar','varchar',{maxLength:100},{maxLength:256},'ACCEPT'],
 ['varchar narrowing','varchar','varchar',{maxLength:256},{maxLength:100},'REJECT'],
 ['char to varchar','char','varchar',{maxLength:50},{maxLength:100},'ACCEPT'],
 ['varchar to char padding','varchar','char',{}, {},'WARN'],
 ['fixed char widening padding','char','char',{maxLength:50},{maxLength:100},'WARN'],
 ['unicode widening','nvarchar','nvarchar',{maxLength:100},{maxLength:256},'ACCEPT'],
 ['unicode to nonunicode','nvarchar','varchar',{}, {},'REJECT'],
 ['utf8 expansion too small','nvarchar','varchar',{maxLength:100},{maxLength:256,codePage:65001},'REJECT'],
 ['utf8 expansion review','nvarchar','varchar',{maxLength:100},{maxLength:300,codePage:65001},'WARN'],
 ['encoding unknown','varchar','varchar',{codePage:undefined},{},'UNKNOWN'],
 ['different code pages','varchar','varchar',{codePage:1252},{codePage:932},'UNKNOWN'],
 ['collation semantics','varchar','varchar',{}, {collation:'Latin1_General_100_CS_AS'},'WARN'],
 ['text to max','text','varchar',{}, {maxLength:-1},'ACCEPT'],
 ['max cannot narrow','nvarchar','nvarchar',{maxLength:-1},{maxLength:4000},'REJECT'],
 ['smallint to int','smallint','int',{}, {},'ACCEPT'],
 ['int to bigint','int','bigint',{}, {},'ACCEPT'],
 ['bigint to int','bigint','int',{}, {},'REJECT'],
 ['sqlserver tinyint is unsigned','tinyint','smallint',{}, {},'ACCEPT'],
 ['signed smallint to sql tinyint','smallint','tinyint',{}, {},'REJECT'],
 ['negative int to unsigned','int','int',{}, {unsigned:true},'REJECT'],
 ['mysql signed tinyint to sql tinyint','tinyint','tinyint',{dialect:'mysql'},{},'REJECT'],
 ['custom unsigned range','int','bigint',{dialect:'custom',integerRange:{min:'0',max:'4294967295'}},{},'ACCEPT'],
 ['decimal total precision','decimal','decimal',{precision:10,scale:2},{precision:12,scale:2},'ACCEPT'],
 ['decimal both capacities','decimal','decimal',{precision:10,scale:2},{precision:12,scale:4},'ACCEPT'],
 ['decimal fractional narrowing','decimal','decimal',{precision:12,scale:4},{precision:10,scale:2},'REJECT'],
 ['increased scale can reduce integer digits','decimal','decimal',{precision:10,scale:2},{precision:10,scale:4},'REJECT'],
 ['decimal numeric synonyms','decimal','numeric',{precision:10,scale:2},{precision:12,scale:4},'ACCEPT'],
 ['int exact decimal range','int','decimal',{}, {precision:10,scale:0},'ACCEPT'],
 ['int insufficient integer digits','int','decimal',{}, {precision:10,scale:2},'REJECT'],
 ['decimal to int rounding','decimal','int',{precision:5,scale:2},{},'REJECT'],
 ['money exact safe expansion','smallmoney','money',{}, {},'ACCEPT'],
 ['float format widening','real','float',{}, {precision:53},'ACCEPT'],
 ['float narrowing','float','real',{precision:53},{},'REJECT'],
 ['float missing format','float','float',{precision:undefined},{},'UNKNOWN'],
 ['do not assume double','double','float',{}, {},'UNKNOWN'],
 ['decimal to float lossy','decimal','float',{}, {},'WARN'],
 ['int fits float53 exactly','int','float',{}, {precision:53},'ACCEPT'],
 ['bigint to float precision loss','bigint','float',{}, {precision:53},'WARN'],
 ['float to decimal full range impossible','float','decimal',{}, {precision:38,scale:0},'REJECT'],
 ['date to datetime has range loss','date','datetime',{}, {},'REJECT'],
 ['date to datetime2','date','datetime2',{}, {},'ACCEPT'],
 ['datetime to date discards time','datetime','date',{}, {},'REJECT'],
 ['temporal precision widening','datetime2','datetime2',{datetimePrecision:3},{datetimePrecision:7},'ACCEPT'],
 ['temporal precision narrowing','datetime2','datetime2',{datetimePrecision:7},{datetimePrecision:3},'REJECT'],
 ['offset to naive','datetimeoffset','datetime2',{}, {},'WARN'],
 ['naive to offset','datetime2','datetimeoffset',{}, {},'WARN'],
 ['small datetime to datetime','smalldatetime','datetime',{}, {},'ACCEPT'],
 ['datetime rounding grid','datetime','datetime2',{}, {},'WARN'],
 ['time to date-bearing type','time','datetime2',{}, {},'WARN'],
 ['cross-system timestamp must be reviewed','timestamp','datetime2',{dialect:'postgresql'},{},'UNKNOWN'],
 ['timestamp is not a SQL date','timestamp','datetime2',{}, {},'UNKNOWN'],
 ['boolean compatible','boolean','bit',{}, {},'ACCEPT'],
 ['documented false0 true1','bit','int',{}, {},'ACCEPT'],
 ['numeric to boolean loses values','int','bit',{}, {},'WARN'],
 ['binary capacity','binary','varbinary',{maxLength:16},{maxLength:32},'ACCEPT'],
 ['binary narrowing','varbinary','varbinary',{maxLength:32},{maxLength:16},'REJECT'],
 ['binary fixed padding','varbinary','binary',{maxLength:16},{maxLength:16},'WARN'],
 ['text binary encoding not implicit','varchar','varbinary',{}, {},'UNKNOWN'],
 ['nullable to notnull','int','int',{nullable:true},{nullable:false,hasDefault:true},'REJECT'],
 ['notnull to nullable','int','int',{nullable:false},{nullable:true},'ACCEPT'],
 ['uuid domain','uniqueidentifier','uuid',{}, {},'ACCEPT'],
 ['enum subset','enum','enum',{enumValues:['a','b']},{enumValues:['a','b','c']},'ACCEPT'],
 ['enum missing value','enum','enum',{enumValues:['a','b']},{enumValues:['a']},'REJECT'],
 ['enum ordinal semantics','enum','enum',{enumValues:['a','b']},{enumValues:['b','a']},'WARN'],
 ['enum unknown domain','enum','enum',{}, {},'UNKNOWN'],
 ['json native same dialect','json','json',{}, {},'ACCEPT'],
 ['xml untyped target','xml','xml',{xmlSchema:'dbo.typed'},{xmlSchema:null},'ACCEPT'],
 ['xml schema not proven','xml','xml',{}, {xmlSchema:'dbo.restricted'},'UNKNOWN'],
 ['spatial cannot assume compatibility','geometry','geometry',{}, {},'UNKNOWN'],
 ['unknown types not accepted by name','mystery','mystery',{}, {},'UNKNOWN'],
 ['alias type constraints','varchar','varchar',{userDefinedType:'dbo.Phone'},{},'UNKNOWN'],
 ['generated target rejected','int','int',{}, {identity:true},'REJECT'],
 ['missing nullability','int','int',{nullable:undefined},{},'UNKNOWN'],
 ['rowversion target generated','varbinary','timestamp',{maxLength:8},{},'REJECT'],
];
for (const [name,s,t,se,te,status] of cases) test(name,()=>{
 const result=assess(s,t,se,te);
 assert.equal(result.status,status,JSON.stringify(result));
 assert.ok(result.errors.length+result.warnings.length+result.unknowns.length+result.notes.length>0);
});

test('every SQL integer pair is classified by exact range containment',()=>{
 const ranges={tinyint:[0n,255n],smallint:[-32768n,32767n],int:[-2147483648n,2147483647n],bigint:[-9223372036854775808n,9223372036854775807n]};
 for(const [s,[smin,smax]] of Object.entries(ranges)) for(const [t,[tmin,tmax]] of Object.entries(ranges)) assert.equal(assess(s,t).status,tmin<=smin && tmax>=smax ? 'ACCEPT':'REJECT',`${s}->${t}`);
});
test('custom reviewed rules remain subject to nullability and generated-column checks',()=>{
 const rule={sourceType:'geometry',targetType:'geometry',status:'ACCEPT',message:'Reviewed identical SRID and spatial constraints.'};
 assert.equal(assessCompatibility(col('s','geometry'),col('t','geometry'),{customRules:[rule]}).status,'ACCEPT');
 assert.equal(assessCompatibility(col('s','geometry',{nullable:true}),col('t','geometry'),{customRules:[rule]}).status,'REJECT');
 assert.equal(assessCompatibility(col('s','geometry'),col('t','geometry',{computed:true}),{customRules:[rule]}).status,'REJECT');
});
test('warning acknowledgements are bound to current warning messages',()=>{
 const source=col('Name','varchar'),target=col('Display','char'),mapping={target:'Display',transformation:'value'},mappings={Name:mapping};
 const result=validateMapping(source,mapping,[target],mappings);
 assert.equal(result.status,'WARN');
 assert.ok(mappingBlockingMessages(result,mapping).length);
 mapping.reviewedWarnings=[...result.warnings];
 assert.deepEqual(mappingBlockingMessages(result,mapping),[]);
 target.maxLength=200;
 const changed=validateMapping(source,mapping,[target],mappings);
 assert.ok(mappingBlockingMessages(changed,mapping).length);
 target.collation='Other_Collation';
 assert.ok(mappingBlockingMessages(validateMapping(source,mapping,[target],mappings),mapping).length);
 assert.equal(changed.status,'WARN');
});
test('UNKNOWN cannot be bypassed by warning acknowledgement',()=>{
 const mapping={target:'T',transformation:'value',reviewedWarnings:['anything']};
 const result=validateMapping(col('S','geometry'),mapping,[col('T','geometry')],{S:mapping});
 assert.equal(result.status,'UNKNOWN');
 assert.ok(mappingBlockingMessages(result,mapping).length);
});
test('formula grammar and zero divisors still reject invalid expressions',()=>{
 for(const expression of ['value/0','value%-0','value.Trim()','value*2; DROP TABLE X','value+2*3']) {
  const mapping={target:'T',transformation:expression};
  assert.equal(validateMapping(col('S','int'),mapping,[col('T','bigint')],{S:mapping}).status,'REJECT',expression);
 }
 const m={target:'T',transformation:'value*2'};
 assert.equal(validateMapping(col('S','int'),m,[col('T','bigint')],{S:m}).status,'WARN');
});
test('defaults apply only to omitted columns and required targets are checked separately',()=>{
 const targets=[col('ID','int',{identity:true}),col('Required','int'),col('Defaulted','int',{hasDefault:true}),col('Optional','int',{nullable:true}),col('Computed','int',{computed:true})];
 assert.equal(requiredTargetErrors(targets,{}).length,1);
 assert.match(requiredTargetErrors(targets,{})[0],/Required/);
 const mapping={target:'Defaulted',transformation:'value'};
 assert.equal(validateMapping(col('S','int',{nullable:true}),mapping,targets,{S:mapping}).status,'REJECT');
});
test('preview accepts safe widening, rejects narrowing and blocks unreviewed warnings',()=>{
 const sources=[col('S','varchar',{maxLength:100})],target=[col('T','varchar',{maxLength:256})],mappings={S:{target:'T',transformation:'value'}};
 assert.match(generateQueryPreview('dbo.Source','dbo.Target',sources,target,mappings),/SELECT/);
 target[0].maxLength=50;
 assert.throws(()=>generateQueryPreview('dbo.Source','dbo.Target',sources,target,mappings),/capacity is insufficient/);
 target[0]=col('T','char',{maxLength:256});
 assert.throws(()=>generateQueryPreview('dbo.Source','dbo.Target',sources,target,mappings),/Warning review required/);
 mappings.S.reviewedWarnings=validateMapping(sources[0],mappings.S,target,mappings).warnings;
 assert.match(generateQueryPreview('dbo.Source','dbo.Target',sources,target,mappings),/INSERT INTO/);
 assert.equal(sqlExpression('value--2','a'),'[a] - (-2)');
 assert.throws(()=>sqlExpression('unknown()','a'),/unsupported/);
});
test('invalid metadata returns UNKNOWN instead of throwing',()=>{
 assert.equal(assessCompatibility(col('S',null),col('T','varchar')).status,'UNKNOWN');
 assert.equal(assess('decimal','decimal',{precision:null}).status,'UNKNOWN');
});
