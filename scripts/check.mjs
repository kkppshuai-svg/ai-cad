#!/usr/bin/env node
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from '../runtime-process.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await loadEnvFile(path.join(root, '.env.local'));
const cadqueryPython = process.env.CADQUERY_PYTHON || path.join(root, '.venv-cadquery', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
const python = process.env.AICAD_CHECK_PYTHON || cadqueryPython;
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
run(python, ['-m', 'py_compile', ...files('scripts', /\.py$/)]);
run(python, ['-m', 'pytest', 'scripts/test_train_cad_vae.py', 'scripts/test_query_cad_vae.py', '-q'], { PYTEST_DISABLE_PLUGIN_AUTOLOAD: '1' });
run(cadqueryPython, ['-m', 'unittest', 'discover', '-s', 'scripts', '-p', 'test_*.py'], { PYTHONPATH: path.join(root, 'scripts') });
if (process.env.USD_BREP_PYTHON) {
  run(process.env.USD_BREP_PYTHON, ['-m', 'unittest', 'discover', '-s', 'scripts', '-p', 'test_usd_brep_build.py']);
  run(process.env.USD_BREP_PYTHON, ['-m', 'unittest', 'discover', '-s', 'scripts', '-p', 'test_native_gears.py']);
}
run(process.execPath, ['--test', ...files('.', /\.test\.mjs$/)]);
