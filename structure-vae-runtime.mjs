// Deterministic posterior mean for Formalatent structure VAE JSON models.
export function encodeStructureTokens(model, tokens) {
  const v = model.vocabulary;
  const dim = model.inputDim;
  if (model.format !== 'formalatent-structure-vae-v1' || !Array.isArray(v) || dim !== v.length + 2) throw new Error('Invalid structure VAE schema');
  const p = model.weights;
  const dense = (x, w, b, size) => {
    if (!Array.isArray(w) || w.length !== x.length || !Array.isArray(b) || b.length !== size || b.some(n => !Number.isFinite(n)) || w.some(row => !Array.isArray(row) || row.length !== size || row.some(n => !Number.isFinite(n)))) throw new Error('Invalid structure VAE weights');
    return b.map((bias, j) => x.reduce((sum, value, i) => sum + value * w[i][j], bias));
  };
  const set = new Set(tokens);
  const x = [...v.map(t => set.has(t) ? 1 : 0), 0, 0];
  const h = dense(x, p.w1, p.b1, model.hiddenDim).map(Math.tanh);
  return dense(h, p.w_mu, p.b_mu, model.latentDim);
}
