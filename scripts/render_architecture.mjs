#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const archify = process.env.ARCHIFY_CLI || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'skills', 'archify', 'bin', 'archify.mjs');
const result = spawnSync(process.execPath, [archify, 'deliver', 'architecture',
  'docs/architecture/aicad.architecture.json', 'public/architecture.html', '--quality', 'showcase', '--json'], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
