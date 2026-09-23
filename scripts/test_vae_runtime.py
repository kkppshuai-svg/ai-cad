import unittest
import numpy as np
from train_brep_vae import train_brep_vae, encode_vectors, decode_latents
from vae_runtime import VaeRuntime

class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.x = np.random.default_rng(3).normal(size=(20, 4))
        self.model = train_brep_vae([{'id': str(i)} for i in range(20)], ['a','b','c','d'], self.x, epochs=10, latent_dim=2)
        self.runtime = VaeRuntime(self.model)

    def test_batch_matches_legacy_and_posterior_is_finite(self):
        mu, lv = self.runtime.encode(self.x, posterior=True)
        np.testing.assert_allclose(mu, encode_vectors(self.model, self.x))
        np.testing.assert_allclose(self.runtime.decode(mu), decode_latents(self.model, mu))
        self.assertTrue(np.isfinite(lv).all())

    def test_hybrid_disambiguates_collapsed_latents(self):
        for key in ('w_mu', 'b_mu'):
            self.model['weights'][key] = np.zeros_like(self.model['weights'][key]).tolist()
        for s in self.model['samples']:
            s['latent'] = [0, 0]
        runtime = VaeRuntime(self.model)
        self.assertEqual(runtime.search(self.x[7:8])[0][0]['id'], '7')

    def test_legacy_index_and_invalid_input(self):
        for s in self.model['samples']:
            del s['geometryVector']
        runtime = VaeRuntime(self.model)
        self.assertEqual(runtime.search(self.x[7:8])[0][0]['id'], '7')
        with self.assertRaises(ValueError):
            runtime.encode([[float('nan')]*4])
        with self.assertRaises(ValueError):
            runtime.decode([[1, 2, 3]])

    def test_minibatches_are_reproducible(self):
        args = ([{'id': str(i)} for i in range(20)], ['a','b','c','d'], self.x)
        a = train_brep_vae(*args, epochs=4, batch_size=3)
        b = train_brep_vae(*args, epochs=4, batch_size=3)
        self.assertEqual(a, b)

if __name__ == '__main__':
    unittest.main()
