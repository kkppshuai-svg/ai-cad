import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveCadqueryExample } from './cadquery-example.js';

test('archived examples rebuild the actual feature tree with the production builder', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aicad-example-'));
  t.after(() => rm(directory, { recursive:true, force:true }));
  const builderPath = path.resolve('scripts/cadquery_build.py');
  const plan = { name:'fixture', parts:[{id:'plate', mode:'generated', reuseStepPath:'/missing/cache.step', featureTree:[
    {id:'base',type:'base_box',enabled:true,dependsOn:[],params:{size:[20,10,4]}},
    {id:'hole',type:'hole',enabled:true,dependsOn:['base'],params:{diameter:4,depth:10,axis:'z',center:[0,0,0]}}
  ]}] };
  await saveCadqueryExample({ plan, directory, builderPath });
  assert.equal(await readFile(path.join(directory, 'cadquery_build.py'),'utf8'), await readFile(builderPath,'utf8'));
  const code = 'import json; from excellent_cadquery import build_example; a,p=build_example(); s=p["plate"].val(); b=s.BoundingBox(); print(json.dumps({"size":[b.xlen,b.ylen,b.zlen],"volume":s.Volume(),"valid":s.isValid()}))';
  const python = process.env.CADQUERY_PYTHON || path.resolve('.venv-cadquery/bin/python');
  const result = JSON.parse(execFileSync(python, ['-c',code], {cwd:directory,encoding:'utf8'}));
  assert.deepEqual(result.size, [20,10,4]);
  assert.ok(result.valid);
  assert.ok(Math.abs(result.volume - (800 - Math.PI * 4 * 4)) < 1e-6);
});

test('examples with engineering requirements include the production evidence evaluator', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aicad-example-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const builderPath = path.resolve('scripts/cadquery_build.py');
  const engineeringVerification = { requirements: [{ id: 'size', kind: 'envelope', maxMm: [20, 10, 4] }] };
  await saveCadqueryExample({ plan: { engineeringVerification }, directory, builderPath });
  const evaluator = 'engineering_verification.py';
  assert.equal(await readFile(path.join(directory, evaluator), 'utf8'), await readFile(path.join(path.dirname(builderPath), evaluator), 'utf8'));
  const plan = JSON.parse(await readFile(path.join(directory, 'feature-plan.json'), 'utf8'));
  assert.deepEqual(plan.engineeringVerification, engineeringVerification);
});

test('archived mounting examples run fixture verification without the repository', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aicad-example-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputDir = path.join(directory, 'output');
  const fixture = { pitchMm: 23, pinCount: 2, travelMm: 6, minSeatFraction: 0.65 };
  const plan = {
    name: 'mount-candidate', outputDir,
    parts: [{ id: 'plate', primitives: [{ type: 'box', size: [51, 41, 4] }],
      features: [-11.5, 11.5].map(y => ({ type: 'slot', axis: 'x', width: 4.4, length: 10.4, center: [-11.5, y, 0] })) }],
    engineeringVerification: { requirements: [{ id: 'mount-interface', kind: 'mount_fixture', fixture }] }
  };
  await saveCadqueryExample({ plan, directory, builderPath: path.resolve('scripts/cadquery_build.py') });
  const python = process.env.CADQUERY_PYTHON || path.resolve('.venv-cadquery/bin/python');
  execFileSync(python, ['cadquery_build.py', 'feature-plan.json'], {
    cwd: directory,
    env: { ...process.env, PYTHONPATH: '', AI_CAD_CADQUERY_MANIFEST: '' }
  });
  const report = JSON.parse(await readFile(path.join(outputDir, 'geometry-validation.json'), 'utf8'));
  assert.equal(report.engineeringVerification.decision, 'pass');
  assert.equal(report.engineeringVerification.verification.claims[0].method, 'pin_sweep_and_washer_seat');
});
