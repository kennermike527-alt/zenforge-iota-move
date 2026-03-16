import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('xen-iota-move');
const indexPath = path.join(root, 'web', 'index.html');
const appPath = path.join(root, 'web', 'app.js');
const dataPath = path.join(root, 'web', 'data', 'latest.json');

const mustExist = (p) => {
  if (!fs.existsSync(p)) throw new Error(`Missing file: ${p}`);
};

const checkContains = (text, needle, label, out) => {
  const ok = text.includes(needle);
  out.push({ label, ok, needle });
};

function main() {
  mustExist(indexPath);
  mustExist(appPath);
  mustExist(dataPath);

  const html = fs.readFileSync(indexPath, 'utf8');
  const app = fs.readFileSync(appPath, 'utf8');
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

  const checks = [];

  checkContains(html, 'Sustainability (mechanics-first)', 'sustainability section', checks);
  checkContains(html, 'Protocol Metrics (current build)', 'metrics section', checks);
  checkContains(html, 'id="liveMetricRank"', 'live metric rank cell', checks);
  checkContains(html, 'id="liveMetricAmp"', 'live metric amp cell', checks);
  checkContains(html, 'id="feeBreakdown"', 'fee breakdown section', checks);
  checkContains(app, 'fetchOnchainState', 'on-chain reader function', checks);
  checkContains(app, "iota_getObject", 'rpc object query', checks);
  checkContains(app, 'renderLiveMetricReadback(data, onchain)', 'readback rendering call', checks);

  const hasDefaultScenario = !!data?.defaultScenario;
  checks.push({ label: 'latest.json has defaultScenario', ok: hasDefaultScenario, needle: 'defaultScenario' });

  const failed = checks.filter((c) => !c.ok);
  if (failed.length) {
    console.error('web smoke: FAIL');
    for (const f of failed) {
      console.error(`- missing: ${f.label} (${f.needle})`);
    }
    process.exit(1);
  }

  console.log('web smoke: PASS');
  for (const c of checks) {
    console.log(`- ${c.label}: ${c.ok ? 'ok' : 'missing'}`);
  }
}

main();
