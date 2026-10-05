import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAssemblyPlan, normalizePlanShape, normalizeInertial } from './assembly-plan.js';

test('legacy plan aliases are normalized and validated with poses and joints', () => {
  const plan = { name:'Fixture assembly', components:[{id:'plate',name:'Plate',primitive:{type:'box',size:[20,10,4]},pose:{translate:[10,0,0]} }], joints:[{child:'plate',type:'revolute'}] };
  normalizePlanShape(plan);
  validateAssemblyPlan(plan);
  assert.equal(plan.parts[0].primitives[0].type, 'box');
  assert.deepEqual(plan.parts[0].pose.translate, [10,0,0]);
  assert.equal(plan.joints[0].type, 'revolute');
  assert.equal(plan.joints[0].parent, 'world');
  assert.equal(plan.activePartId, 'plate');
});

test('standard parts require a valid request and cannot fall back to generated geometry', () => {
  assert.throws(() => validateAssemblyPlan({parts:[{id:'bolt',name:'Bolt',mode:'standard_part'}]}), /requires an id, query, or facet/);
  const plan = {parts:[{id:'bolt',name:'Bolt',mode:'standard_part',standardPart:{query:'M3 screw'}}]};
  validateAssemblyPlan(plan);
  assert.deepEqual(plan.parts[0].featureTree, []);
  assert.deepEqual(plan.parts[0].primitives, []);
});

test('invalid inertial values are rejected without inventing a mass', () => {
  assert.equal(normalizeInertial({mass:-1}), null);
  assert.equal(normalizeInertial(null), null);
  assert.equal(normalizeInertial({mass:1}).inertia.ixx, 0.001);
});
