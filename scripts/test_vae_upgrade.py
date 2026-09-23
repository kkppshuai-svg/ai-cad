import unittest
import numpy as np
from train_brep_vae import train_brep_vae, decode_latents, encode_vectors, forward, model_params

class UpgradeTests(unittest.TestCase):
    def setUp(self):
        self.x = np.arange(60, dtype=float).reshape(20, 3)
        self.records = [{'id': str(i)} for i in range(20)]
        self.names = ['x', 'y', 'z']

    def test_normalization_excludes_validation_data(self):
        model = train_brep_vae(self.records, self.names, self.x, epochs=2)
        indices = model['training']['trainIndices']
        np.testing.assert_allclose(model['normalization']['mean'], self.x[indices].mean(axis=0))
        other = self.x.copy()
        other[model['training']['validationIndices']] += 10000
        changed = train_brep_vae(self.records, self.names, other, epochs=2)
        self.assertEqual(model['normalization'], changed['normalization'])

    def test_decoder_matches_forward_pass(self):
        model = train_brep_vae(self.records, self.names, self.x, epochs=5)
        z = encode_vectors(model, self.x)
        mean = np.array(model['normalization']['mean'])
        std = np.array(model['normalization']['std'])
        expected = forward(model_params(model), (self.x-mean)/std, sample=False)['out']*std+mean
        np.testing.assert_allclose(decode_latents(model, z), expected)

    def test_finetune_preserves_all_weights_with_negligible_step(self):
        model = train_brep_vae(self.records, self.names, self.x, epochs=3)
        tuned = train_brep_vae(self.records, self.names, self.x, epochs=1, initial_model=model, learning_rate=1e-30)
        for key in model['weights']:
            np.testing.assert_allclose(tuned['weights'][key], model['weights'][key], atol=1e-25)

    def test_rejects_nonfinite_features(self):
        self.x[0, 0] = np.nan
        with self.assertRaises(ValueError):
            train_brep_vae(self.records, self.names, self.x)

if __name__ == '__main__':
    unittest.main()
