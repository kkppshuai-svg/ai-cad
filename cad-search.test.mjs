import test from 'node:test';
import assert from 'node:assert/strict';
import { createCadSearch } from './cad-search.js';

const env = { AICAD_WEB_SEARCH_LOCAL_FIRST: '0', AICAD_WEB_SEARCH_CURL_FALLBACK: '0' };
test('local CAD references return without a network request', async () => {
  const search = createCadSearch({ env: {}, fetchImpl: () => { throw new Error('unexpected network'); } });
  const result = await search.searchCadReferences('电机安装支架');
  assert.equal(result.provider, 'local-cad-library');
  assert.ok(result.results.length);
  assert.equal(result.error, null);
});

test('AnySearch uses configured credentials and normalizes results', async () => {
  const search = createCadSearch({ env: { ...env, ANYSEARCH_API_KEY: 'test-key' }, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.anysearch.com/v1/search');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    assert.equal(JSON.parse(options.body).max_results, 2);
    return { ok: true, text: async () => JSON.stringify({ items: [{ name: 'CadQuery examples', link: 'https://cadquery.readthedocs.io/examples', content: 'Python workplane' }] }) };
  } });
  const result = await search.searchCadReferences('unlisted-topic', { maxResults: 2 });
  assert.equal(result.provider, 'anysearch');
  assert.equal(result.results[0].title, 'CadQuery examples');
  const prompt = search.formatSearchContextForPrompt(result);
  assert.equal(JSON.parse(prompt).untrusted, true);
  assert.doesNotMatch(prompt, /test-key/);
});

test('remote failures fall back to local data and unknown topics report failure', async () => {
  const search = createCadSearch({ env, fetchImpl: async () => { throw new Error('offline'); }, runProcess: async () => { throw new Error('offline'); } });
  assert.equal((await search.searchCadReferences('电机支架')).provider, 'local-cad-library');
  const result = await search.searchCadReferences('xyzzzy');
  assert.deepEqual(result.results, []);
  assert.ok(result.error);
});

test('Bing fallback parses links and excludes irrelevant results from planning', async () => {
  const search = createCadSearch({ env: { ...env, AICAD_WEB_SEARCH_PROVIDER: 'bing-cn' }, runProcess: async () => ({ stdout: '<li class="b_algo"><h2><a href="https://github.com/cadquery/cadquery">CadQuery &amp; Python</a></h2><p>Workplane example</p></li>' }) });
  const result = await search.searchCadReferences('xyzzzy');
  assert.equal(result.provider, 'bing-cn');
  assert.equal(result.results[0].title, 'CadQuery & Python');
  const prompt = JSON.parse(search.formatSearchContextForPrompt({ ...result, results: [...result.results, {title:'Python video',url:'https://youtube.com/watch',snippet:'CadQuery'}] }));
  assert.equal(prompt.results.length, 1);
});
