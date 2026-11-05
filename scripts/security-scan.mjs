import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  findings = [];
let scanned = 0;
async function walk(directory) {
  for (const e of await fs.readdir(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'generated', '.data', '.git', '版本'].includes(e.name)) continue;
    const full = path.join(directory, e.name);
    if (e.isDirectory()) await walk(full);
    else if (/\.(ts|tsx|mjs|ps1|json|yaml|yml|md)$/.test(e.name)) {
      scanned++;
      const content = await fs.readFile(full, 'utf8');
      const rules = [
        ['private-key', /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/],
        ['api-token', /\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}\b/],
        ['cloud-key', /\bAKIA[0-9A-Z]{16}\b/],
      ];
      for (const [name, pattern] of rules)
        if (pattern.test(content)) findings.push({ file: path.relative(root, full), rule: name });
    }
  }
}
for (const folder of ['apps', 'packages', 'scripts', 'database', 'docs'])
  await walk(path.join(root, folder));
const report = {
  scanned,
  findings,
  scope:
    'source/config/docs only; local .env/.data and immutable archives excluded; values never printed',
};
console.log(JSON.stringify(report, null, 2));
if (findings.length) process.exitCode = 1;
