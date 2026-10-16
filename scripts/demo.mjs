import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const cases=[
  ['Clean manifests','scan-manifests.js',['fixtures/manifests/clean'],0],
  ['Findings remain failures','scan-manifests.js',['fixtures/manifests/with-findings'],1],
  ['No targets is not a pass','scan-manifests.js',['fixtures/manifests/empty'],2],
  ['Too many explicit skips','scan-manifests.js',['fixtures/manifests/mostly-skipped'],2],
  ['Override preserves uncertainty','scan-manifests.js',['fixtures/manifests/empty','--override-by','demo-reviewer','--override-reason','synthetic empty environment'],0],
  ['Healthy synthetic samples','error-rate.js',['fixtures/samples/healthy.json'],0],
  ['No traffic is not zero errors','error-rate.js',['fixtures/samples/no_traffic.json'],2],
  ['Incomplete samples','error-rate.js',['fixtures/samples/gap.json'],2],
  ['A detected spike','error-rate.js',['fixtures/samples/spike.json'],1],
];
for(const [label,script,args,expected] of cases){
  console.log(`\n${label}\n${'─'.repeat(label.length)}`);
  const result=spawnSync(process.execPath,[join(root,'examples',script),...args],{cwd:root,encoding:'utf8',timeout:10_000,windowsHide:true});
  process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
  console.log(`exit: ${result.status}; expected: ${expected}`);
  if(result.error||result.status!==expected){console.error(result.error?.message??'Unexpected verdict');process.exitCode=1;}
}
console.log('\nFor the heartbeat lifecycle and changing-input assertions: node scripts/scenarios.mjs');
