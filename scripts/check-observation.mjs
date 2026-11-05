import fs from 'node:fs/promises';
import path from 'node:path';
import { profilePath, read } from './native.mjs';
const p = process.argv[2] ?? 'production',
  hours = process.argv.includes('--24h'),
  runtime = path.dirname(profilePath(p)),
  obs = await read(path.join(runtime, 'observation.json')),
  coverage = hours ? obs.twentyFourHours.coverage : obs.thirtyMinutes.coverage,
  result = {
    profile: p,
    window: hours ? '24h' : '30min',
    ...obs,
    result:
      coverage && obs.failedSamples === 0 && obs.alertSamples === 0
        ? 'passed'
        : 'pending_or_needs_review',
  };
if (process.argv[3] && !process.argv[3].startsWith('--'))
  await fs.writeFile(process.argv[3], JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
if (result.result !== 'passed') process.exitCode = 2;
