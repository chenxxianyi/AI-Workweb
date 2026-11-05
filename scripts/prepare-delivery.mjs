import fs from 'node:fs/promises';
import path from 'node:path';
import { root, data, read, json, profilePath, verifyRelease } from './native.mjs';
const release = 'local-final-v5',
  { manifest } = await verifyRelease(release),
  runtime = path.dirname(profilePath('production')),
  status = await read(path.join(runtime, 'backup-status.json')),
  metadata = await read(path.join(data, 'backups/production', status.id + '.json')),
  observation = await read(path.join(runtime, 'observation.json'));
const pinsFile = path.join(runtime, 'retention-pins.json'),
  pins = await read(pinsFile).catch(() => []);
await json(pinsFile, [...new Set([...pins, '1793852582038-76537285', status.id])]);
const inventory = {
  scope: 'Windows本机开发与技术验收；最终FS052核验凭证为封存依据',
  release,
  url: 'http://127.0.0.1:3000',
  staging: 'http://127.0.0.1:3003',
  manifest: '运行包release.json；摘要见FS050/artifact-integrity-private.log',
  files: manifest.files.length,
  lockHash: manifest.lockHash,
  backup: {
    id: status.id,
    sha256: metadata.sha256,
    bytes: metadata.bytes,
    createdAt: metadata.header.createdAt,
    tables: Object.keys(metadata.header.rows).length,
    location: '.data/backups/production，密钥另存受限backup-keys目录',
  },
  validation: {
    unitTests: 200,
    postgresSuites: 26,
    productionCases: 14,
    responsiveCases: 90,
    initialObservation: '30min passed',
  },
  observation: {
    startedAt: observation.startedAt,
    lastAt: observation.lastAt,
    samples: observation.samples,
    failed: observation.failedSamples,
    alerts: observation.alertSamples,
    twentyFourHours: '后台继续，尚未结束，不提前写通过',
    report: '.data/runtime/production/observation-24h.json',
  },
  checkpoints: 'FS001～FS052；实际版本路径见全栈开发任务/任务进度.md，各manifest独立核验',
  credentials: '仅在受限runtime/production/credentials.txt，无密码写入交付文档',
  extensions: [
    'Safari/物理设备/原生ChromeEdge交互未验证',
    '异机灾备',
    '公网HTTPS',
    '外部CI/告警',
    '完整自动强类型SDK',
  ],
  createdAt: new Date().toISOString(),
};
await fs.writeFile(
  path.join(root, 'docs/交付清单.json'),
  JSON.stringify(inventory, null, 2) + '\n',
);
await fs.appendFile(
  path.join(root, 'docs/本机发布记录.md'),
  '\n最终FS052冻结前再次生成正式备份：' +
    status.id +
    '，24表；旧F50恢复点与当前冻结点已固定保留。密文SHA256：' +
    metadata.sha256 +
    '。\n',
);
console.log(
  JSON.stringify({
    release,
    backup: status.id,
    backupTables: inventory.backup.tables,
    observationSamples: observation.samples,
    credentialsIncluded: false,
  }),
);
