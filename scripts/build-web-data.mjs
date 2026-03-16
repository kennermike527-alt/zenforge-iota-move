import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('xen-iota-move');
const reportsDir = path.join(root, 'reports');
const outDir = path.join(root, 'web', 'data');
const outPath = path.join(outDir, 'latest.json');

if (!fs.existsSync(reportsDir)) {
  throw new Error(`Reports directory not found: ${reportsDir}`);
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

const reportEntries = fs
  .readdirSync(reportsDir)
  .filter((d) => d.startsWith('sim-'))
  .map((d) => {
    const replayPath = path.join(reportsDir, d, 'replay.json');
    if (!fs.existsSync(replayPath)) return null;
    const replay = readJson(replayPath);
    return {
      dir: d,
      path: replayPath,
      replay,
      generatedAtTs: Date.parse(replay.generatedAt || ''),
    };
  })
  .filter(Boolean)
  .sort((a, b) => b.generatedAtTs - a.generatedAtTs);

if (!reportEntries.length) {
  throw new Error('No simulation replay.json files found in reports/');
}

const byScenario = new Map();
for (const e of reportEntries) {
  if (!byScenario.has(e.replay.scenarioName)) byScenario.set(e.replay.scenarioName, e);
}

const defaultEntry = byScenario.get('default') || reportEntries[0];

const sum = (arr, key) => arr.reduce((n, x) => n + Number(x?.[key] || 0), 0);

const defaultReplay = defaultEntry.replay;
const claims = defaultReplay.claims || [];
const stakes = defaultReplay.stakes || [];
const timeline = defaultReplay.timeline || [];

const sampleStep = Math.max(1, Math.floor(timeline.length / 28));
const timelineSample = timeline.filter((_, i) => i % sampleStep === 0 || i === timeline.length - 1);

const topClaims = [...claims]
  .sort((a, b) => Number(b.netReward || 0) - Number(a.netReward || 0))
  .slice(0, 6)
  .map((c) => ({
    user: c.user,
    cRank: c.cRank,
    netReward: Number(c.netReward || 0),
    grossReward: Number(c.grossReward || 0),
    penaltyPct: Number(c.penaltyPct || 0),
    settleDay: Number(c.settleDay || 0),
  }));

const attackScenarioNames = [
  'attack-spam-rank-shock',
  'attack-late-claim-wave',
  'attack-stake-churn-pressure',
];

const attackCards = attackScenarioNames
  .map((name) => {
    const entry = byScenario.get(name);
    if (!entry) return null;
    const r = entry.replay;
    const rClaims = r.claims || [];
    const rStakes = r.stakes || [];
    const totalGross = sum(rClaims, 'grossReward');
    const totalNet = sum(rClaims, 'netReward');
    const totalStakeReward = sum(rStakes, 'reward');
    const avgPenalty = rClaims.length ? sum(rClaims, 'penaltyPct') / rClaims.length : 0;

    return {
      scenarioName: name,
      generatedAt: r.generatedAt,
      claims: rClaims.length,
      stakes: rStakes.length,
      totalGross,
      totalNet,
      totalStakeReward,
      avgPenalty: Number(avgPenalty.toFixed(2)),
      driftPct: totalGross > 0 ? Number((((totalNet - totalGross) / totalGross) * 100).toFixed(2)) : 0,
    };
  })
  .filter(Boolean);

const payload = {
  generatedAt: new Date().toISOString(),
  defaultScenario: {
    name: defaultReplay.scenarioName,
    reportDir: defaultEntry.dir,
    sourceGeneratedAt: defaultReplay.generatedAt,
    finalGlobalRank: Number(defaultReplay.finalGlobalRank || 0),
    totals: {
      claims: claims.length,
      stakes: stakes.length,
      grossClaimReward: sum(claims, 'grossReward'),
      netClaimReward: sum(claims, 'netReward'),
      totalStakeReward: sum(stakes, 'reward'),
      maturedStakes: stakes.filter((s) => !!s.matured).length,
    },
    timelineSample,
    topClaims,
  },
  attackCards,
};

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
console.log(`Web data written: ${outPath}`);
