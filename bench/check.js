import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
async function walk(path) {
  for (const f of await readdir(path, { withFileTypes: true })) {
    const p = `${path}/${f.name}`;
    if (f.isDirectory()) await walk(p);
    else if (p.endsWith('.js')) {
      const r = spawnSync(process.execPath, ['--check', p], { stdio: 'inherit' });
      if (r.status !== 0) process.exit(1);
    }
  }
}
for (const path of ['apps', 'packages', 'test', 'bench']) await walk(path);
console.log('JavaScript syntax checks passed');
