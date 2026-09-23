"""Compiled NumPy inference runtime with reusable validated arrays and batched search."""
import numpy as np
from train_brep_vae import init_params, model_params

class VaeRuntime:
    def __init__(self, model):
        self.model = model
        if model.get('format') != 'ai-cad-brep-vae-v2':
            raise ValueError('unsupported model format')
        self.params = model_params(model)
        expected = init_params(model['inputDim'], model['hiddenDim'], model['latentDim'], np.random.default_rng(0))
        for name, value in expected.items():
            if name not in self.params or self.params[name].shape != value.shape or not np.isfinite(self.params[name]).all():
                raise ValueError(f'invalid weight: {name}')
        self.mean = np.asarray(model['normalization']['mean'], dtype=float)
        self.std = np.asarray(model['normalization']['std'], dtype=float)
        if self.mean.shape != (model['inputDim'],) or self.std.shape != self.mean.shape or not np.isfinite([self.mean, self.std]).all() or (self.std <= 0).any():
            raise ValueError('invalid normalization')
        self.samples = model.get('samples', [])
        self.latents = self._matrix([s['latent'] for s in self.samples], model['latentDim']) if self.samples else np.empty((0, model['latentDim']))
        self.geometry = None
        if self.samples and all('geometryVector' in s for s in self.samples):
            self.geometry = (self._matrix([s['geometryVector'] for s in self.samples], model['inputDim']) - self.mean) / self.std

    @staticmethod
    def _matrix(value, dimension):
        result = np.asarray(value, dtype=float)
        if result.ndim != 2 or result.shape[1] != dimension or not np.isfinite(result).all():
            raise ValueError(f'expected finite matrix with {dimension} columns')
        return result

    def encode(self, vectors, posterior=False):
        x = self._matrix(vectors, self.model['inputDim'])
        p = self.params
        h = np.tanh(((x-self.mean)/self.std) @ p['w1'] + p['b1'])
        mu = h @ p['w_mu'] + p['b_mu']
        if posterior:
            return mu, np.clip(h @ p['w_lv'] + p['b_lv'], -8, 5)
        return mu

    def decode(self, latents):
        z = self._matrix(latents, self.model['latentDim'])
        p = self.params
        return (np.tanh(z @ p['w2'] + p['b2']) @ p['w_out'] + p['b_out']) * self.std + self.mean

    def reconstruct(self, vectors):
        return self.decode(self.encode(vectors))

    def search(self, vectors, limit=5, geometry_weight=0.5):
        """Hybrid normalized descriptor/latent distance, with legacy latent fallback."""
        if not 0 <= geometry_weight <= 1 or limit < 1:
            raise ValueError('invalid search settings')
        x = self._matrix(vectors, self.model['inputDim'])
        z = self.encode(x)
        results = []
        # Query-wise vectorization bounds memory to the index size.
        for query, latent in zip(x, z):
            distances = np.linalg.norm(self.latents-latent, axis=1)
            scores = distances / np.sqrt(self.model['latentDim'])
            geometry_distances = None
            if self.geometry is not None and geometry_weight:
                geometry_distances = np.linalg.norm(self.geometry-(query-self.mean)/self.std, axis=1) / np.sqrt(self.model['inputDim'])
                scores = (1-geometry_weight)*scores + geometry_weight*geometry_distances
            # Stable tie ordering, including numeric/string IDs.
            order = np.lexsort((np.array([str(s.get('id')) for s in self.samples]), scores))[:limit]
            results.append([{**{k: self.samples[i].get(k) for k in ('id', 'name', 'assemblyId')}, 'distance': float(distances[i]), 'score': float(scores[i]), 'geometryDistance': None if geometry_distances is None else float(geometry_distances[i])} for i in order])
        return results
