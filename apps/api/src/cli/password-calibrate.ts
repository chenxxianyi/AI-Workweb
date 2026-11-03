#!/usr/bin/env node
import { hashPassword, PASSWORD_HASH_PARAMS, validatePasswordPolicy } from '../modules/auth/password.js';

/**
 * Argon2id 参数校准（F08）。
 * 在目标部署机器上运行，观察单次哈希耗时；目标 0.5～1s。
 * 若明显偏慢/偏快，调整 password.ts 的 memoryCost / timeCost 后重新测量并记录。
 */
const samples = 3;
const password = 'calibration-passphrase-1234';

const violations = validatePasswordPolicy(password);
console.log('参数：', {
  type: 'argon2id',
  memoryCostKiB: PASSWORD_HASH_PARAMS.memoryCost,
  timeCost: PASSWORD_HASH_PARAMS.timeCost,
  parallelism: PASSWORD_HASH_PARAMS.parallelism,
});
console.log('策略自检：', violations.length === 0 ? '通过' : violations);

const durations: number[] = [];
for (let index = 0; index < samples; index += 1) {
  const started = process.hrtime.bigint();
  await hashPassword(password);
  durations.push(Number(process.hrtime.bigint() - started) / 1_000_000);
}

const average = durations.reduce((sum, value) => sum + value, 0) / durations.length;
console.log(`耗时（毫秒）：${durations.map((value) => value.toFixed(1)).join(' / ')}；平均 ${average.toFixed(1)}`);
console.log(average >= 300 && average <= 1500 ? '结论：在建议区间内（0.3～1.5s）' : '结论：偏离建议区间，请调整参数后复测');
