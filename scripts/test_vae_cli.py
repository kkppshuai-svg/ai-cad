import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
import numpy as np
from train_brep_vae import train_brep_vae, write_model

class CliTests(unittest.TestCase):
    def test_cli_roundtrip_and_search(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            x = np.random.default_rng(1).normal(size=(10, 3))
            model = train_brep_vae([{'id': str(i)} for i in range(10)], ['a','b','c'], x, epochs=3)
            write_model(model, root/'model.json')
            (root/'input.json').write_text(json.dumps(x.tolist()))
            script = Path(__file__).with_name('vae_cli.py')
            def call(operation, input_path):
                return json.loads(subprocess.check_output([sys.executable, str(script), operation, '--model', str(root/'model.json'), '--input', str(input_path)], text=True))
            latent = call('encode', root/'input.json')
            (root/'latent.json').write_text(json.dumps(latent))
            decoded = call('decode', root/'latent.json')
            np.testing.assert_allclose(decoded, call('reconstruct', root/'input.json'))
            matches = call('search', root/'input.json')
            self.assertEqual([r[0]['id'] for r in matches], [str(i) for i in range(10)])

if __name__ == '__main__':
    unittest.main()
