import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('xen-iota-move');
const reportsDir = path.join(root, 'reports');

const cfg = {
  rpcUrl: process.env.ZENFORGE_RPC_URL || 'https://api.testnet.iota.cafe',
  protocolId:
    process.env.ZENFORGE_PROTOCOL_ID ||
    '0x3fb22d58d2ce2f6c603a64428d37bd164ecad60564a9e823de8c393b5a428678',
  expectedPackage:
    process.env.ZENFORGE_PACKAGE_ID ||
    '0x4a146c82ea75b2894da92d52b40d9406bfab7ddc9abf38ff97fd3013190548fd',
  network: process.env.ZENFORGE_NETWORK || 'testnet',
};

const DAY_MS = 86_400_000;
const AMP_START = 3000;
const APY_START_BPS = 2000;
const APY_MIN_BPS = 200;

const floorLog2 = (x) => {
  let v = Math.max(1, Math.floor(Number(x || 1)));
  let n = 0;
  while (v > 1) {
    v = Math.floor(v / 2);
    n += 1;
  }
  return n;
};

const freeMintTermLimit = (globalRank) => {
  const r = Math.max(1, Math.floor(Number(globalRank || 1)));
  if (r <= 5000) return 100;
  return 100 + floorLog2(r) * 15;
};

const ampAtNow = (nowMs, genesisMs) => {
  const daysSince = nowMs > genesisMs ? Math.floor((nowMs - genesisMs) / DAY_MS) : 0;
  if (daysSince >= AMP_START - 1) return 1;
  return AMP_START - daysSince;
};

const apyAtNow = (nowMs, genesisMs) => {
  const daysSince = nowMs > genesisMs ? Math.floor((nowMs - genesisMs) / DAY_MS) : 0;
  const decay = Math.floor(daysSince / 90) * 100;
  if (decay >= APY_START_BPS - APY_MIN_BPS) return APY_MIN_BPS;
  return APY_START_BPS - decay;
};

async function rpcCall(method, params) {
  const res = await fetch(cfg.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || JSON.stringify(body.error));
  return body.result;
}

async function main() {
  const startedAt = new Date().toISOString();
  const nowMs = Date.now();

  const obj = await rpcCall('iota_getObject', [cfg.protocolId, { showContent: true, showType: true }]);
  const fields = obj?.data?.content?.fields;
  if (!fields) throw new Error('Protocol object fields unavailable');

  const packageFromType = String(obj?.data?.type || '').split('::')[0];
  const genesisMs = Number(fields.genesis_ts_ms || 0);
  const globalRank = Number(fields.global_rank || 0);
  const activeMints = Number(fields?.active_mints?.fields?.size || 0);
  const activeStakes = Number(fields?.active_stakes?.fields?.size || 0);
  const totalSupplyRaw = String(fields?.treasury?.fields?.total_supply?.fields?.value || '0');

  const derived = {
    maxTermDays: freeMintTermLimit(globalRank),
    currentAmp: ampAtNow(nowMs, genesisMs),
    currentApyBps: apyAtNow(nowMs, genesisMs),
  };

  const checks = {
    packageMatchesExpected: !cfg.expectedPackage || packageFromType.toLowerCase() === cfg.expectedPackage.toLowerCase(),
    globalRankNonNegative: globalRank >= 0,
    maxTermAtLeast100: derived.maxTermDays >= 100,
    ampInRange: derived.currentAmp >= 1 && derived.currentAmp <= 3000,
    apyInRange: derived.currentApyBps >= 200 && derived.currentApyBps <= 2000,
  };

  const ok = Object.values(checks).every(Boolean);

  const report = {
    ok,
    startedAt,
    network: cfg.network,
    rpcUrl: cfg.rpcUrl,
    protocolId: cfg.protocolId,
    packageFromType,
    expectedPackage: cfg.expectedPackage,
    objectVersion: obj?.data?.version || null,
    objectDigest: obj?.data?.digest || null,
    onchain: {
      genesisTsMs: genesisMs,
      globalRank,
      activeMints,
      activeStakes,
      totalSupplyRaw,
    },
    derived,
    checks,
  };

  fs.mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[.:]/g, '-');
  const outTs = path.join(reportsDir, `onchain-check-${stamp}.json`);
  const outLatest = path.join(reportsDir, 'onchain-check-latest.json');
  fs.writeFileSync(outTs, JSON.stringify(report, null, 2));
  fs.writeFileSync(outLatest, JSON.stringify(report, null, 2));

  console.log(`onchain check: ${ok ? 'PASS' : 'FAIL'}`);
  console.log(`report: ${outLatest}`);
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error('onchain check failed:', err.message || err);
  process.exitCode = 1;
});
