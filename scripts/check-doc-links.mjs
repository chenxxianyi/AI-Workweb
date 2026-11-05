import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const documents = [],
  broken = [];
let checked = 0;
async function walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (['版本', 'node_modules', '.data', '.git'].includes(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(file);
    else if (entry.name.endsWith('.md')) documents.push(file);
  }
}
await walk(path.join(root, 'docs'));
await walk(path.join(root, '全栈开发任务'));
documents.push(path.join(root, 'README.md'));
for (const file of documents) {
  const body = await fs.readFile(file, 'utf8');
  for (const match of body.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    let href = match[1].replace(/^<|>$/g, '').split(/\s+['"]/)[0];
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) continue;
    href = href.split('#')[0].split('?')[0];
    if (!href) continue;
    try {
      href = decodeURIComponent(href);
    } catch {
      /*保留原名供报告*/
    }
    const target = path.resolve(path.dirname(file), href);
    checked++;
    try {
      await fs.access(target);
    } catch {
      broken.push({ file: path.relative(root, file), href });
    }
  }
}
const result = {
  documents: documents.length,
  localLinks: checked,
  broken,
  result: broken.length ? 'failed' : 'passed',
  scope: '本地链接存在性；外链与页内锚点不联网校验',
};
console.log(JSON.stringify(result, null, 2));
if (broken.length) process.exitCode = 1;
