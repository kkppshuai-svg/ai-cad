#!/usr/bin/env node
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = (directory, pattern) => readdirSync(path.join(root, directory))
  .filter(name => pattern.test(name)).sort().map(name => path.join(directory, name));
function run(command, args, env = {}) {
  const result = spawnSync(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

for (const file of [...files('.', /\.(?:js|mjs)$/), ...files('public', /\.js$/), ...files('scripts', /\.mjs$/)]) {
  run(process.execPath, ['--check', file]);
}
run('python3', ['-m', 'py_compile', ...files('scripts', /\.py$/)]);
run('python3', ['-m', 'pytest', 'scripts/test_train_cad_vae.py', 'scripts/test_query_cad_vae.py', '-q'], { PYTEST_DISABLE_PLUGIN_AUTOLOAD: '1' });
const cadqueryPython = process.env.CADQUERY_PYTHON || path.join(root, '.venv-cadquery', 'bin', 'python');
run(cadqueryPython, ['-m', 'unittest', 'discover', '-s', 'scripts', '-p', 'test_*.py'], { PYTHONPATH: path.join(root, 'scripts') });
run(process.execPath, ['--test', ...files('.', /\.test\.mjs$/)]);
