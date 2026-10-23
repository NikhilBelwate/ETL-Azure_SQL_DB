"use client";

import { useState } from "react";
import { QueryPreview } from "@/components/query-preview";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { useEtl } from "@/components/etl-provider";
import type { ColumnInfo } from "@/lib/azureSql";
import { automaticColumnMappings, sameTableName } from "@/lib/automatic-mappings";
import { columnDefinition, generateQueryPreview, mappingBlockingMessages, requiredTargetErrors, transformationHelp, validateMapping, type ColumnMapping, type ColumnMappingValues } from "@/lib/mapping-validation";

export function ColumnMappings({ sourceName, targetName, sourceColumns, targetColumns }: {
  sourceName: string; targetName: string; sourceColumns: ColumnInfo[]; targetColumns: ColumnInfo[];
}) {
  const { plan,setPlan,mappingDraft,setMappingDraft } = useEtl();
  const saved = plan?.sourceName===sourceName && plan?.targetName===targetName ? plan
    : mappingDraft?.sourceName===sourceName && mappingDraft?.targetName===targetName ? mappingDraft : null;
  const mappings: ColumnMappingValues = saved?.mappings ?? automaticColumnMappings(sourceName,targetName,sourceColumns,targetColumns);
  const [query,setQuery] = useState(()=> {
    if (plan?.sourceName!==sourceName || plan?.targetName!==targetName) return "";
    try { return generateQueryPreview(sourceName,targetName,sourceColumns,targetColumns,plan.mappings); }
    catch { return ""; }
  });
  const [generation,setGeneration] = useState(0);
  const [generationError,setGenerationError] = useState("");
  const validations = sourceColumns.map(column=>validateMapping(column,mappings[column.name] || {target:"",transformation:""},targetColumns,mappings));
  const invalidMappings = sourceColumns.flatMap((column,index)=>{
    const issues = mappingBlockingMessages(validations[index],mappings[column.name]);
    return issues.length ? [{column,index,issues}] : [];
  });
  const requiredErrors = requiredTargetErrors(targetColumns,mappings);
  const issueCount = invalidMappings.reduce((total,mapping)=>total+mapping.issues.length,0)+requiredErrors.length;
  const selectedCount = sourceColumns.filter(column=>mappings[column.name]?.target).length;
  function update(name:string,change:Partial<ColumnMapping>) {
    setPlan(null); setQuery(""); setGenerationError("");
    const next = {...mappings,[name]:{target:"",transformation:"",...mappings[name],reviewedWarnings:[],...change}};
    setMappingDraft({sourceName,targetName,sourceColumns,targetColumns,mappings:next});
  }
  function generate() {
    setQuery(""); setGenerationError("");
    try {
      setQuery(generateQueryPreview(sourceName,targetName,sourceColumns,targetColumns,mappings));
      setGeneration(previous=>previous+1);
      setPlan({sourceName,targetName,sourceColumns,targetColumns,mappings});
    } catch (error) { setGenerationError(error instanceof Error ? error.message : "Unable to validate this mapping. Reload table metadata and review the highlighted issues before retrying."); }
  }
  return <section className="space-y-4" aria-labelledby="mappings-heading">
    <h2 id="mappings-heading" className="text-xl font-semibold">Column Mappings</h2>
    {sameTableName(sourceName,targetName) && <p role="status" className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">Matching table names: same-name columns are preselected. Review compatibility below and adjust mappings as needed. Columns without an exact name match stay unmapped.</p>}
    <p className="text-sm text-muted-foreground">Compatibility is directional: the target must preserve every source value. Safe widening is accepted. Unsafe conversions are rejected; warnings require your review. UNKNOWN mappings need an approved compatibility rule.</p>
    <p className="text-xs text-muted-foreground">Azure SQL / SQL Server profile · TINYINT is 0–255. TIMESTAMP is a generated binary row version, not a date/time type. Leave a source unmapped to skip it; an empty formula copies its value.</p>
    {issueCount>0 && <div role="status" className="space-y-2 rounded-xl border border-amber-500/50 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200">
      <h3 className="font-semibold">Compatibility review required: {issueCount} {issueCount===1 ? "issue" : "issues"}</h3>
      <p>Query generation and loading remain blocked until errors and unknowns are resolved and conversion warnings are reviewed.</p>
      <ul className="list-disc space-y-1 pl-5">{invalidMappings.map(({column,index,issues})=><li key={column.name}><a href={`#mapping-row-${index}`} className="font-medium underline">{column.name} → {mappings[column.name]?.target}</a> — {validations[index].status}: {issues.length} {issues.length===1 ? "issue" : "issues"}</li>)}</ul>
      {requiredErrors.length>0 && <div><p className="font-semibold">Required target columns</p><ul className="list-disc space-y-1 pl-5">{requiredErrors.map(message=><li key={message}>{message}</li>)}</ul></div>}
    </div>}
    {sourceColumns.length===0 && <p>No source columns are available.</p>}
    {sourceColumns.map((column,index)=>{
      const mapping = mappings[column.name] || {target:"",transformation:""};
      const target = targetColumns.find(candidate=>candidate.name===mapping.target);
      const validation = validations[index];
      const {status,errors,warnings,unknowns,notes} = validation;
      const invalid = errors.length>0 || unknowns.length>0;
      const reviewed = warnings.length>0 && warnings.every(message=>mapping.reviewedWarnings?.includes(message));
      const helpId=`expression-help-${index}`,validationId=`validation-${index}`;
      return <div id={`mapping-row-${index}`} tabIndex={-1} key={column.name} className={`grid scroll-mt-6 items-start gap-4 rounded-xl border p-4 md:grid-cols-3 ${errors.length ? "border-red-500/60" : unknowns.length || warnings.length ? "border-amber-500/50" : "border-border"}`}>
        <div><p className="break-all font-medium">{column.name}</p><p className="text-sm text-muted-foreground">{columnDefinition(column)}{column.nullable ? " · nullable" : " · NOT NULL"}</p></div>
        <div><label htmlFor={`target-${index}`} className="mb-1 block text-sm">Target for {column.name}</label><Select id={`target-${index}`} value={mapping.target} aria-invalid={invalid} aria-describedby={validationId} onValueChange={target=>update(column.name,{target})} options={[{value:"",label:"Not mapped"},...targetColumns.map(candidate=>({value:candidate.name,label:`${candidate.name} (${columnDefinition(candidate)})`}))]}/></div>
        <div><label htmlFor={`expression-${index}`} className="mb-1 block text-sm">Transformation for {column.name}</label><Input id={`expression-${index}`} value={mapping.transformation} disabled={!mapping.target} aria-invalid={invalid} aria-describedby={`${helpId} ${validationId}`} placeholder="value (copy unchanged)" onChange={event=>update(column.name,{transformation:event.target.value})}/><p id={helpId} className="mt-2 text-xs text-muted-foreground">{transformationHelp(column)}</p></div>
        <div id={validationId} aria-live="polite" className="min-w-0 space-y-3 text-sm md:col-span-3">
          {!mapping.target ? <p className="text-muted-foreground">Not mapped</p> : <>
            <div className="flex flex-wrap gap-6 text-xs text-muted-foreground"><p>Source: <span className="font-mono text-foreground">{columnDefinition(column)}</span></p><p>Target: <span className="font-mono text-foreground">{target ? columnDefinition(target) : "Unavailable — reload tables"}</span></p></div>
            {status==="ACCEPT" && <div className="rounded-md bg-green-500/10 p-3 text-green-800 dark:text-green-300"><h3 className="font-semibold">ACCEPT — source values fit the target</h3><ul className="mt-1 list-disc space-y-1 pl-5">{notes.map(message=><li key={message}>{message}</li>)}</ul></div>}
            {errors.length>0 && <div className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-red-700 dark:text-red-300"><h3 className="font-semibold">REJECT — mapping can lose data or fail</h3><ul className="mt-2 list-disc space-y-2 pl-5">{errors.map(message=><li key={message}>{message}</li>)}</ul></div>}
            {unknowns.length>0 && <div className="rounded-md border border-violet-500/40 bg-violet-500/10 p-3 text-violet-800 dark:text-violet-300"><h3 className="font-semibold">UNKNOWN — compatibility is not proven</h3><ul className="mt-2 list-disc space-y-2 pl-5">{unknowns.map(message=><li key={message}>{message}</li>)}</ul><p className="mt-2 font-medium">Resolve missing metadata or configure an approved compatibility rule before loading.</p></div>}
            {warnings.length>0 && <div className="space-y-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-amber-900 dark:text-amber-200"><h3 className="font-semibold">WARN — review conversion semantics</h3><ul className="list-disc space-y-2 pl-5">{warnings.map(message=><li key={message}>{message}</li>)}</ul>{!invalid && <label className="flex items-start gap-2 font-medium"><input type="checkbox" className="mt-1" checked={reviewed} onChange={event=>update(column.name,{reviewedWarnings:event.target.checked ? [...warnings] : []})}/>I reviewed and accept these conversion/formula warnings for {column.name}</label>}</div>}
          </>}
        </div>
      </div>;
    })}
    <p id="mapping-validation-summary" role="status" className="text-sm text-muted-foreground">{selectedCount} mapped columns · {issueCount ? `${issueCount} issues require attention` : "no unresolved compatibility issues"}</p>
    {generationError && <div role="alert" className="space-y-2 rounded-md border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-300"><h3 className="font-semibold">Query preview could not be generated</h3><p>{generationError}</p><p>No query was executed. Correct or review the mapping, then try again.</p></div>}
    <Button onClick={generate} disabled={issueCount>0} aria-describedby="mapping-validation-summary">Generate Query Preview</Button>
    {query && <QueryPreview key={generation} query={query} plan={{sourceName,targetName,sourceColumns,targetColumns,mappings}} />}
  </section>;
}
