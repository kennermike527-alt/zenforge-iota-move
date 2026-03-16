import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const writeBaselines = args.includes('--write-baselines');
const checkBaselines = args.includes('--check-baselines');

const root = path.resolve('xen-iota-move');
const scenariosDir = path.join(root, 'scenarios', 'attack-pack');
const script = path.join(root, 'scripts', 'simulate-tokenomics.mjs');

if (!fs.existsSync(scenariosDir)) {
  throw new Error(`Scenarios folder missing: ${scenariosDir}`);
}

const scenarios = fs
  .readdirSync(scenariosDir)
  .filter((f) => f.endsWith('.json'))
  .sort();

if (!scenarios.length) {
  throw new Error('No attack scenarios found');
}

let failed = 0;
let passed = 0;

for (const file of scenarios) {
  const configPath = path.join(scenariosDir, file);
  const scenarioName = path.basename(file, '.json');
  const baselinePath = path.join(root, 'baselines', `${scenarioName}.baseline.json`);

  const runArgs = [script, '--config', configPath, '--assert-invariants', '--baseline', baselinePath];
  if (writeBaselines) runArgs.push('--write-baseline');
  if (checkBaselines) runArgs.push('--check-baseline');

  console.log(`\n=== Running ${file} ===`);
  const p = spawnSync(process.execPath, runArgs, { encoding: 'utf8' });

  const out = [p.stdout || '', p.stderr || ''].join('\n').trim();
  if (out) console.log(out);

  if (p.status === 0) {
    passed += 1;
    console.log(`RESULT: PASS (${file})`);
  } else {
    failed += 1;
    console.log(`RESULT: FAIL (${file}) exit=${p.status}`);
  }
}

console.log(`\nAttack pack done. pass=${passed} fail=${failed}`);
if (failed > 0) process.exit(2);
