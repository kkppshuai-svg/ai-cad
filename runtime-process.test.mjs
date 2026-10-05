import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadEnvFile, buildChildEnv, createProcessRunner } from './runtime-process.js';

test('env loading preserves explicit values and parses quoted defaults', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aicad-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, '.env');
  await writeFile(file, '# comment\nPORT=3101\nexport MODEL="example-model"\nHOST=localhost # local\n');
  const env = { PORT: '9999' };
  await loadEnvFile(file, env);
  assert.deepEqual(env, { PORT: '9999', MODEL: 'example-model', HOST: 'localhost' });
  assert.deepEqual(buildChildEnv({PATH:'/bin', HOME:'/tmp', UNRELATED_SECRET:'hidden'}), { PATH:'/bin', HOME:'/tmp' });
});

test('process runner honors cwd, stdin and bounded output', async () => {
  const run = createProcessRunner(os.tmpdir());
  const result = await run(process.execPath, ['-e', 'process.stdin.on("data", b => process.stdout.write(process.cwd()+":"+b))'], { input: 'hello', timeoutMs: 5000 });
  assert.equal(result.stdout, os.tmpdir()+':hello');
  const bounded = await run(process.execPath, ['-e', 'process.stdout.write("0123456789")'], { maxBuffer: 5 });
  assert.equal(bounded.stdout, '56789');
});

test('process runner rejects nonzero exits and terminates timeouts', async () => {
  const run = createProcessRunner(os.tmpdir());
  await assert.rejects(run(process.execPath, ['-e', 'process.stderr.write("failure");process.exit(2)']), /code 2\nfailure/);
  await assert.rejects(run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 200 }), /timed out/);
});
