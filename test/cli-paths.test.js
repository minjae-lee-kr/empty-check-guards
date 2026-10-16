import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

test('real CLIs run from directories with spaces, Unicode and URL control characters', () => {
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const tempRoot=resolve(tmpdir());
  const scratch=mkdtempSync(join(tempRoot,'guard path 한글 #% '));
  assert.equal(dirname(scratch),tempRoot);
  try {
    for(const name of ['src','examples','fixtures','package.json'])cpSync(join(root,name),join(scratch,name),{recursive:true});
    const cases=[
      ['scan-manifests.js',['fixtures/manifests/empty'],2,/\[INCONCLUSIVE\]/],
      ['error-rate.js',['fixtures/samples/spike.json'],1,/\[FAIL\]/],
      ['heartbeat.js',['check','not-created.json','--max-age-hours','24'],2,/\[MISSING\]/],
    ];
    for(const [script,args,status,pattern] of cases){
      const result=spawnSync(process.execPath,[join(scratch,'examples',script),...args],{cwd:scratch,encoding:'utf8',timeout:10_000,windowsHide:true});
      assert.ifError(result.error);assert.equal(result.status,status,result.stderr);assert.match(result.stdout,pattern);
    }
  } finally {
    assert.equal(dirname(scratch),tempRoot);
    rmSync(scratch,{recursive:true,force:true});
  }
});
