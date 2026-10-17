// Exercise the real CLI while its inputs change between invocations.
// The harness passes when the expected failures remain failures.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const temporaryRoot=resolve(tmpdir());
const scratch=mkdtempSync(join(temporaryRoot,'empty-check-scenarios-'));
assert.equal(dirname(scratch),temporaryRoot);
let assertions=0;
function run(expected,script,...args){
  const result=spawnSync(process.execPath,[join(root,'examples',script),...args],{encoding:'utf8',cwd:root,timeout:10_000,windowsHide:true});
  assert.ifError(result.error);
  assert.equal(result.status,expected,`${script}: ${result.stdout}\n${result.stderr}`);
  assertions++;
  console.log(`ok  exit ${expected}: ${script}`);
  return result.stdout;
}
function contains(text,pattern){assert.match(text,pattern);assertions++;}
try{
  const manifests=join(scratch,'manifests');
  await cp(join(root,'fixtures','manifests','clean'),manifests,{recursive:true});
  console.log('Readable input → missing source → empty source → recorded override');
  contains(run(0,'scan-manifests.js',manifests),/\[PASS\]/);
  assert.equal(dirname(manifests),scratch);
  rmSync(manifests,{recursive:true});
  contains(run(2,'scan-manifests.js',manifests),/target source unavailable/);
  mkdirSync(manifests);
  contains(run(2,'scan-manifests.js',manifests),/no targets were discovered/);
  const over=run(0,'scan-manifests.js',manifests,'--override-by','demo-reviewer','--override-reason','synthetic intentionally empty environment');
  contains(over,/\[INCONCLUSIVE\]/);contains(over,/OVERRIDE recorded, by "demo-reviewer"/);
  contains(run(1,'scan-manifests.js',join(root,'fixtures','manifests','with-findings'),'--override-by','demo-reviewer','--override-reason','cannot hide a finding'),/override refused: run is fail/);
  console.log('No traffic remains inconclusive; a healthy sample can pass');
  contains(run(2,'error-rate.js',join(root,'fixtures','samples','no_traffic.json')),/\[INCONCLUSIVE\]/);
  contains(run(0,'error-rate.js',join(root,'fixtures','samples','healthy.json')),/\[PASS\]/);
  console.log('Missing heartbeat → refused write → completed failing verdict → fresh heartbeat');
  const heartbeat=join(scratch,'heartbeat.json');
  contains(run(2,'heartbeat.js','check',heartbeat,'--max-age-hours','24'),/\[MISSING\]/);
  run(2,'heartbeat.js','touch',heartbeat,'--job','synthetic-check');
  assert.equal(existsSync(heartbeat),false,'refused touch must not create a record');assertions++;
  run(0,'heartbeat.js','touch',heartbeat,'--job','synthetic-check','--verdict','fail');
  contains(run(0,'heartbeat.js','check',heartbeat,'--max-age-hours','24'),/\[FRESH\].*verdict fail/);
  console.log(`All ${assertions} scenario assertions passed.`);
}finally{
  assert.equal(dirname(scratch),temporaryRoot);
  rmSync(scratch,{recursive:true,force:true});
}
