// Syntax check plus unit tests, the same on every platform. npm runs scripts in
// cmd.exe on Windows, where a shell for-loop is a syntax error and Node 20 does
// not expand `test/*.test.mjs` itself, so the file lists are built here.
//
//   node test/run.mjs               syntax check, then every test/*.test.mjs
//   node test/run.mjs --check-only  syntax check only
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = args => spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' }).status ?? 1;
const filesIn = (dir, suffix) => readdirSync(join(ROOT, dir)).filter(f => f.endsWith(suffix)).sort().map(f => `${dir}/${f}`);

for (const file of ['index.js', ...filesIn('modules', '.js')]) {
    const status = run(['--check', file]);
    if (status !== 0) process.exit(status);
}
if (process.argv.includes('--check-only')) process.exit(0);
process.exit(run(['--test', ...filesIn('test', '.test.mjs')]));
