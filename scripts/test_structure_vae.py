import copy
import json
import subprocess
import sys
import unittest
from pathlib import Path
import tempfile
import numpy as np
from structure_vae import train, StructureVAE, objective, vectorize
from train_brep_vae import init_params


def samples(n=24):
    return [{'id':str(i),'tokens':['common',f'family:{i%3}','quality:excellent','freecad:visible'], 'structure':{'partCount':i%3+1,'jointCount':i%2},'quality':{'score':100}} for i in range(n)]


class StructureTests(unittest.TestCase):
    def test_reparameterized_gradients_against_finite_difference(self):
        rng=np.random.default_rng(1); p=init_params(4,3,2,rng)
        x=np.array([[1,0,0.2,0.4],[0,1,-0.5,0.1]])
        loss,metrics,g=objective(p,x,2,0.1,np.random.default_rng(10))
        for key in p:
            for ix in np.ndindex(p[key].shape):
                old=p[key][ix]; eps=1e-5
                p[key][ix]=old+eps; a=objective(p,x,2,0.1,np.random.default_rng(10))[0]
                p[key][ix]=old-eps; b=objective(p,x,2,0.1,np.random.default_rng(10))[0]
                p[key][ix]=old
                self.assertAlmostEqual(g[key][ix],(a-b)/(2*eps),places=6,msg=key)

    def test_quality_independent_reproducible_training(self):
        a=samples(); b=copy.deepcopy(a)
        for s in b:
            s['quality']={'score':0};s['tokens']=[t for t in s['tokens'] if not t.startswith(('quality:','freecad:'))]+['quality:failed','freecad:constraint-failed']
        first=train(a,epochs=25); second=train(b,epochs=25)
        self.assertEqual(first['weights'],second['weights'])
        self.assertLess(first['metrics']['validationLoss'], first['metrics']['initialValidationLoss'])
        runtime=StructureVAE(first)
        mu,lv=runtime.encode(a,posterior=True)
        self.assertTrue(np.isfinite(lv).all())
        self.assertGreater(float(np.std(mu)),0)
        out=runtime.decode(mu)
        self.assertTrue(((out['tokenProbabilities']>=0)&(out['tokenProbabilities']<=1)).all())
        self.assertTrue(np.isfinite(out['counts']).all())

    def test_train_only_vocabulary_and_normalization(self):
        a=samples(); m=train(a,epochs=2); vi=m['training']['validationIndices']
        for i in vi:
            a[i]['tokens'].append('validation-only')
            a[i]['structure']['partCount']=10000
        changed=train(a,epochs=2)
        self.assertNotIn('validation-only',changed['vocabulary'])
        self.assertEqual(m['countNormalization'],changed['countNormalization'])
        runtime=StructureVAE(m)
        self.assertTrue(np.isfinite(runtime.encode([{'tokens':['unknown']}])).all())
        with self.assertRaises(ValueError): runtime.decode([[float('nan')]*m['latentDim']])
        with self.assertRaises(ValueError): runtime.encode([{'structure':{'partCount':-1}}])

    def test_neural_cli_and_legacy_switch(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); ds=root/'data.jsonl'; model=root/'model.json'
            ds.write_text(''.join(json.dumps(s)+'\n' for s in samples()))
            scripts=Path(__file__).parent
            result=subprocess.run([sys.executable,str(scripts/'train_cad_vae.py'),'--dataset',str(ds),'--out',str(model),'--epochs','10'],check=True,capture_output=True,text=True)
            self.assertEqual(json.loads(result.stdout)['format'],'formalatent-structure-vae-v1')
            result=subprocess.run([sys.executable,str(scripts/'query_cad_vae.py'),'--model',str(model),'--query','common'],check=True,capture_output=True,text=True)
            self.assertEqual(len(json.loads(result.stdout)['latent']),8)

if __name__=='__main__': unittest.main()
