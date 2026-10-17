import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { cp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

test('real CLIs run from directories with spaces, Unicode and URL control characters', async () => {
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const tempRoot=resolve(tmpdir());
  const scratch=mkdtempSync(join(tempRoot,'guard path 한글 #% '));
  assert.equal(dirname(scratch),tempRoot);
  try {
    // Node 22 on Windows can fail inside cpSync for Unicode paths before a CLI runs.
    for(const name of ['src','examples','fixtures','scripts','package.json'])await cp(join(root,name),join(scratch,name),{recursive:true});
    const cases=[
      ['examples/scan-manifests.js',['fixtures/manifests/empty'],2,/\[INCONCLUSIVE\]/],
      ['examples/error-rate.js',['fixtures/samples/spike.json'],1,/\[FAIL\]/],
      ['examples/heartbeat.js',['check','not-created.json','--max-age-hours','24'],2,/\[MISSING\]/],
      ['scripts/scenarios.mjs',[],0,/All 22 scenario assertions passed\./],
    ];
    for(const [script,args,status,pattern] of cases){
      const entry=join(scratch,script);
      assert.ok((await stat(entry)).isFile(),`Copied CLI entry is missing: ${script}`);
      const result=spawnSync(process.execPath,[entry,...args],{cwd:scratch,encoding:'utf8',timeout:10_000,windowsHide:true});
      assert.ifError(result.error);assert.equal(result.status,status,result.stderr);assert.match(result.stdout,pattern);
    }
  } finally {
    assert.equal(dirname(scratch),tempRoot);
    rmSync(scratch,{recursive:true,force:true});
  }
});
