import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const cache = new Map();
async function compile(url) {
  if (cache.has(url.href)) return cache.get(url.href);
  let code = ts.transpileModule(await readFile(url,'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
  for (const match of [...code.matchAll(/from\s+["'](\.[^"']+)["']/g)]) {
    const ref = match[1], dependency = new URL(ref.endsWith('.ts') ? ref : `${ref}.ts`,url);
    const compiled = await compile(dependency);
    code = code.replace(match[0],`from ${JSON.stringify(compiled)}`);
  }
  for (const match of [...code.matchAll(/from\s+["']([^.'"][^'"]*)["']/g)]) {
    code = code.replace(match[0], `from ${JSON.stringify(import.meta.resolve(match[1]))}`);
  }
  const compiled = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  cache.set(url.href,compiled);
  return compiled;
}
export async function importTypescript(url) { return import(await compile(url)); }
