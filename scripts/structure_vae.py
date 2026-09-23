"""Neural VAE for unordered CAD tokens and counts; quality stays in ranking metadata."""
import copy
import numpy as np
from train_brep_vae import init_params, forward, adam_step

FORMAT = 'formalatent-structure-vae-v1'
COUNTS = ('partCount', 'jointCount')
EXCLUDED = ('quality:', 'freecad:', 'cadquery:')


def tokens(sample):
    return sorted({t for t in sample.get('tokens', []) if isinstance(t, str) and not t.startswith(EXCLUDED)})


def counts(sample):
    values = [float((sample.get('structure') or {}).get(k, 0)) for k in COUNTS]
    if not np.isfinite(values).all() or min(values) < 0:
        raise ValueError('structure counts must be finite and nonnegative')
    return np.log1p(values)


def vectorize(samples, vocabulary, mean, std):
    lookup = {t: i for i, t in enumerate(vocabulary)}
    x = np.zeros((len(samples), len(vocabulary)+2))
    for row, sample in enumerate(samples):
        for token in tokens(sample):
            if token in lookup:
                x[row, lookup[token]] = 1
        # Missing counts are unknown (training mean), not zero parts/joints.
        structure = sample.get('structure') or {}
        raw = counts(sample)
        x[row, -2:] = [(raw[j]-mean[j])/std[j] if k in structure else 0 for j,k in enumerate(COUNTS)]
    return x


def sigmoid(x):
    return np.exp(-np.logaddexp(0, -x))


def objective(params, x, token_count, beta, rng=None, encoder_x=None):
    c = forward(params, x if encoder_x is None else encoder_x, rng=rng, sample=rng is not None)
    out = c['out']; n = len(x); v = token_count
    bce = float(np.mean(np.logaddexp(0, out[:, :v])-x[:, :v]*out[:, :v]))
    mse = float(np.mean((out[:, v:]-x[:, v:])**2))
    kl = float(np.mean(-0.5*(1+c['logvar']-c['mu']**2-np.exp(c['logvar']))))
    d_out = np.concatenate(((sigmoid(out[:, :v])-x[:, :v])/(n*v), 2*(out[:, v:]-x[:, v:])/(n*2)), axis=1)
    g = {'w_out': c['dh'].T @ d_out, 'b_out': d_out.sum(0)}
    d_h2 = (d_out @ params['w_out'].T)*(1-c['dh']**2)
    g.update(w2=c['z'].T @ d_h2, b2=d_h2.sum(0))
    d_z = d_h2 @ params['w2'].T
    scale = n*c['mu'].shape[1]
    d_mu = d_z + beta*c['mu']/scale
    d_lv = (d_z*c['epsilon']*0.5*c['std'] + beta*0.5*(np.exp(c['logvar'])-1)/scale)
    d_lv *= (c['raw_lv'] >= -8) & (c['raw_lv'] <= 5)
    g.update(w_mu=c['h'].T @ d_mu, b_mu=d_mu.sum(0), w_lv=c['h'].T @ d_lv, b_lv=d_lv.sum(0))
    d_h = (d_mu @ params['w_mu'].T + d_lv @ params['w_lv'].T)*(1-c['h']**2)
    g.update(w1=c['x'].T @ d_h, b1=d_h.sum(0))
    return bce+mse+beta*kl, {'tokenBce':bce,'countMse':mse,'kl':kl}, g


def train(samples, latent_dim=8, hidden_dim=64, epochs=400, learning_rate=0.003, beta=0.01, batch_size=32, seed=42, warmup_epochs=20):
    if len(samples) < 3:
        raise ValueError('neural structure VAE requires at least three samples')
    if min(latent_dim, hidden_dim, epochs, batch_size) < 1 or warmup_epochs < 0 or not np.isfinite([learning_rate,beta]).all() or learning_rate <= 0 or beta < 0:
        raise ValueError('invalid training parameters')
    rng = np.random.default_rng(seed)
    order = rng.permutation(len(samples)); nv = max(1, round(len(samples)*0.2))
    ti, vi = order[nv:], order[:nv]
    vocabulary = sorted({t for i in ti for t in tokens(samples[i])})
    if not vocabulary:
        raise ValueError('training split contains no structural tokens')
    raw = np.array([counts(s) for s in samples])
    mean, std = raw[ti].mean(0), raw[ti].std(0); std[std < 1e-8] = 1
    x = vectorize(samples, vocabulary, mean, std); v = len(vocabulary)
    p = init_params(x.shape[1], hidden_dim, latent_dim, rng)
    state = {k:{name:np.zeros_like(a) for name,a in p.items()} for k in ('m','v')}
    best_loss, initial_metrics, _ = objective(p,x[vi],v,beta)
    best = copy.deepcopy(p); best_epoch = 0; stale = 0; step = 0
    for epoch in range(1,epochs+1):
        order = rng.permutation(ti)
        for start in range(0,len(order),batch_size):
            target = x[order[start:start+batch_size]]
            encoded = target.copy()
            # Text-only queries omit counts; train this case explicitly.
            encoded[rng.random(len(encoded)) < 0.5, -2:] = 0
            _,_,g = objective(p,target,v,beta*min(1,epoch/max(1,warmup_epochs)),rng,encoded)
            step += 1; adam_step(p,g,state,step,learning_rate)
        value,_,_ = objective(p,x[vi],v,beta)
        if not np.isfinite(value):
            raise ValueError('training diverged')
        if value < best_loss-1e-7:
            best_loss,best,best_epoch,stale = value,copy.deepcopy(p),epoch,0
        else:
            stale += 1
        if stale >= max(60,warmup_epochs):
            break
    _,metrics,_ = objective(best,x[vi],v,beta)
    latent = forward(best,x,sample=False)['mu']
    return {'format':FORMAT,'sampleCount':len(samples),'inputDim':x.shape[1], 'hiddenDim':hidden_dim,'latentDim':latent_dim,
            'vocabulary':vocabulary,'numericFeatures':list(COUNTS),'countNormalization':{'transform':'log1p','mean':mean.tolist(),'std':std.tolist()},
            'weights':{k:a.tolist() for k,a in best.items()},
            'training':{'seed':seed,'epochsCompleted':epoch,'bestEpoch':best_epoch,'beta':beta,'learningRate':learning_rate,'batchSize':batch_size,'warmupEpochs':warmup_epochs,'trainIndices':ti.tolist(),'validationIndices':vi.tolist(),'qualityPolicy':'ranking-only','excludedTokenPrefixes':list(EXCLUDED),'countMaskProbability':0.5},
            'metrics':{'validationLoss':best_loss,'initialValidationLoss':sum((initial_metrics['tokenBce'],initial_metrics['countMse'],beta*initial_metrics['kl'])),**metrics},
            'samples':[{'id':s.get('id'),'name':s.get('name'),'quality':s.get('quality'),'tokens':tokens(s),'latent':latent[i].tolist()} for i,s in enumerate(samples)]}


class StructureVAE:
    def __init__(self, model):
        if model.get('format') != FORMAT:
            raise ValueError('unsupported structure model format')
        self.model = model; self.vocabulary = model['vocabulary']
        if not self.vocabulary or len(set(self.vocabulary)) != len(self.vocabulary) or model['inputDim'] != len(self.vocabulary)+2:
            raise ValueError('invalid vocabulary')
        self.params = {k:np.asarray(a,dtype=float) for k,a in model['weights'].items()}
        expected = init_params(model['inputDim'],model['hiddenDim'],model['latentDim'],np.random.default_rng(0))
        for k,a in expected.items():
            if k not in self.params or self.params[k].shape != a.shape or not np.isfinite(self.params[k]).all():
                raise ValueError(f'invalid weight {k}')
        self.mean = np.asarray(model['countNormalization']['mean']); self.std = np.asarray(model['countNormalization']['std'])
        if self.mean.shape != (2,) or self.std.shape != (2,) or not np.isfinite([self.mean,self.std]).all() or (self.std <= 0).any():
            raise ValueError('invalid count normalization')

    def encode(self, samples, posterior=False):
        x = vectorize(samples,self.vocabulary,self.mean,self.std)
        c = forward(self.params,x,sample=False)
        return (c['mu'],c['logvar']) if posterior else c['mu']

    def decode(self, latent):
        z = np.asarray(latent,dtype=float)
        if z.ndim != 2 or z.shape[1] != self.model['latentDim'] or not np.isfinite(z).all():
            raise ValueError('invalid latent matrix')
        p = self.params
        out = np.tanh(z@p['w2']+p['b2'])@p['w_out']+p['b_out']
        return {'tokenProbabilities':sigmoid(out[:,:-2]),'counts':np.maximum(0,np.expm1(np.clip(out[:,-2:]*self.std+self.mean,0,20)))}
