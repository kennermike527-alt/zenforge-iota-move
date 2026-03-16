import fs from 'node:fs';
import path from 'node:path';

const DAY_MS = 86_400_000;
const AMP_START = 3_000;
const EAA_START_BPS = 1_000; // 10%
const APY_START_BPS = 2_000; // 20%
const APY_MIN_BPS = 200; // 2%
const BPS_DENOM = 10_000n;

const latePenaltyPct = (daysLate) => {
  if (daysLate <= 0) return 0;
  if (daysLate === 1) return 1;
  if (daysLate === 2) return 3;
  if (daysLate === 3) return 8;
  if (daysLate === 4) return 17;
  if (daysLate === 5) return 35;
  if (daysLate === 6) return 72;
  return 99;
};

const floorLog2 = (x) => {
  let v = Number(x);
  let n = 0;
  while (v > 1) {
    v = Math.floor(v / 2);
    n += 1;
  }
  return n;
};

const freeMintTermLimit = (globalRank) =>
  globalRank <= 5_000 ? 100 : 100 + floorLog2(globalRank) * 15;

const ampAtDay = (day) => {
  const d = Math.max(0, Math.floor(day));
  return d >= AMP_START - 1 ? 1 : AMP_START - d;
};

const eaaBpsForRank = (rank) => {
  const decay = Math.floor(rank / 100_000) * 10;
  return Math.max(EAA_START_BPS - decay, 0);
};

const apyBpsAtDay = (day) => {
  const decay = Math.floor(Math.max(0, day) / 90) * 100;
  return Math.max(APY_START_BPS - decay, APY_MIN_BPS);
};

const toBig = (n) => BigInt(Math.max(0, Math.floor(Number(n || 0))));
const fromBig = (b) => Number(b.toString());

const stakeReward = (principal, apyBps, termDays) => {
  const p = toBig(principal);
  const a = toBig(apyBps);
  const t = toBig(termDays);
  return fromBig((p * a * t) / BPS_DENOM / 365n);
};

const defaultScenario = {
  name: 'default',
  claims: [
    { user: 'alice', day: 0, termDays: 100, settleDay: 100 },
    { user: 'bob', day: 1, termDays: 30, settleDay: 35 },
    { user: 'carol', day: 2, termDays: 14, settleDay: 20 },
    { user: 'dave', day: 10, termDays: 60, settleDay: 75 },
    { user: 'erin', day: 20, termDays: 45, settleDay: 120 }, // intentionally late
    { user: 'frank', day: 40, termDays: 90, settleDay: 140 },
    { user: 'grace', day: 55, termDays: 21, settleDay: 80 },
  ],
  stakes: [
    { user: 'alice', day: 120, principal: 100_000, termDays: 30, withdrawDay: 150 },
    { user: 'bob', day: 121, principal: 100_000, termDays: 30, withdrawDay: 130 }, // early withdraw
  ],
};

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    config: null,
    baseline: null,
    writeBaseline: false,
    checkBaseline: false,
    assertInvariants: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--config') out.config = args[i + 1];
    if (args[i] === '--baseline') out.baseline = args[i + 1];
    if (args[i] === '--write-baseline') out.writeBaseline = true;
    if (args[i] === '--check-baseline') out.checkBaseline = true;
    if (args[i] === '--assert-invariants') out.assertInvariants = true;
  }

  return out;
}

function loadScenario(configPath) {
  if (!configPath) return defaultScenario;
  const abs = path.resolve(configPath);
  return JSON.parse(fs.readFileSync(abs, 'utf8'));
}

function simulateClaims(claimsInput) {
  const claims = [...claimsInput]
    .map((c, idx) => ({ ...c, idx }))
    .sort((a, b) => (a.day - b.day) || (a.idx - b.idx));

  let globalRank = 0;

  const claimsState = claims.map((c) => {
    const maxTerm = freeMintTermLimit(globalRank);
    if (c.termDays < 1 || c.termDays > maxTerm) {
      throw new Error(`Invalid termDays=${c.termDays} for ${c.user} at globalRank=${globalRank}; max=${maxTerm}`);
    }

    globalRank += 1;
    const cRank = globalRank;
    const ampAtClaim = ampAtDay(c.day);
    const eaaBps = eaaBpsForRank(cRank);
    const maturityDay = c.day + c.termDays;

    return {
      ...c,
      cRank,
      globalRankAtClaim: globalRank,
      maxTermAtClaim: maxTerm,
      ampAtClaim,
      eaaBps,
      maturityDay,
    };
  });

  const rankAtDay = (day) => claimsState.filter((c) => c.day <= day).length;

  const settled = claimsState.map((c) => {
    const settleDay = c.settleDay ?? c.maturityDay;
    const rankDelta = Math.max(rankAtDay(settleDay) - c.cRank, 1);
    const logRank = floorLog2(rankDelta);

    const gross = fromBig(
      (toBig(logRank) * toBig(c.termDays) * toBig(c.ampAtClaim) * (BPS_DENOM + toBig(c.eaaBps))) / BPS_DENOM,
    );

    const lateDays = Math.max(settleDay - c.maturityDay, 0);
    const penaltyPct = latePenaltyPct(lateDays);
    const net = fromBig((toBig(gross) * toBig(100 - penaltyPct)) / 100n);

    return {
      user: c.user,
      claimDay: c.day,
      termDays: c.termDays,
      settleDay,
      cRank: c.cRank,
      rankDelta,
      logRank,
      ampAtClaim: c.ampAtClaim,
      eaaBps: c.eaaBps,
      maturityDay: c.maturityDay,
      lateDays,
      penaltyPct,
      grossReward: gross,
      netReward: net,
    };
  });

  return { claimsState, settled, finalGlobalRank: globalRank };
}

function simulateStakes(stakesInput) {
  const stakes = [...(stakesInput || [])]
    .map((s, idx) => ({ ...s, idx }))
    .sort((a, b) => (a.day - b.day) || (a.idx - b.idx));

  return stakes.map((s) => {
    const apyBps = apyBpsAtDay(s.day);
    const maturityDay = s.day + s.termDays;
    const matured = (s.withdrawDay ?? maturityDay) >= maturityDay;
    const reward = matured ? stakeReward(s.principal, apyBps, s.termDays) : 0;
    return {
      ...s,
      apyBps,
      maturityDay,
      matured,
      reward,
      payout: Number(s.principal || 0) + reward,
    };
  });
}

function buildTimeline(maxDay, claimStates) {
  const rankAtDay = (day) => claimStates.filter((c) => c.day <= day).length;
  const rows = [];
  for (let d = 0; d <= maxDay; d += 1) {
    const rank = rankAtDay(d);
    rows.push({
      day: d,
      globalRank: rank,
      amp: ampAtDay(d),
      apyBps: apyBpsAtDay(d),
      eaaBpsAtCurrentRank: eaaBpsForRank(Math.max(rank, 1)),
      maxTermDaysAtCurrentRank: freeMintTermLimit(Math.max(rank, 1)),
    });
  }
  return rows;
}

function toCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n');
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function buildSummaryMd(name, settled, stakes, timeline) {
  const totalGross = settled.reduce((n, r) => n + r.grossReward, 0);
  const totalNet = settled.reduce((n, r) => n + r.netReward, 0);
  const avgPenalty = settled.length
    ? (settled.reduce((n, r) => n + r.penaltyPct, 0) / settled.length).toFixed(2)
    : '0.00';

  const lines = [];
  lines.push(`# XEN-IOTA Deterministic Simulation — ${name}`);
  lines.push('');
  lines.push(`- Claims simulated: ${settled.length}`);
  lines.push(`- Stakes simulated: ${stakes.length}`);
  lines.push(`- Total gross claim reward: ${totalGross}`);
  lines.push(`- Total net claim reward: ${totalNet}`);
  lines.push(`- Average penalty (%): ${avgPenalty}`);
  lines.push('');
  lines.push('## Claim settlements');
  lines.push('| user | cRank | claimDay | term | settleDay | lateDays | penalty% | gross | net |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of settled) {
    lines.push(`| ${r.user} | ${r.cRank} | ${r.claimDay} | ${r.termDays} | ${r.settleDay} | ${r.lateDays} | ${r.penaltyPct} | ${r.grossReward} | ${r.netReward} |`);
  }
  lines.push('');
  lines.push('## Stake settlements');
  lines.push('| user | day | term | withdrawDay | apyBps | matured | reward | payout |');
  lines.push('|---|---:|---:|---:|---:|:---:|---:|---:|');
  for (const s of stakes) {
    lines.push(`| ${s.user} | ${s.day} | ${s.termDays} | ${s.withdrawDay} | ${s.apyBps} | ${s.matured ? 'yes' : 'no'} | ${s.reward} | ${s.payout} |`);
  }
  lines.push('');
  lines.push(`Timeline points: ${timeline.length}`);

  return lines.join('\n');
}

function checkpointDays(maxDay) {
  const base = [0, 1, 7, 14, 30, 60, 90, 120, 180, 270, 365, maxDay];
  return [...new Set(base.filter((d) => d >= 0 && d <= maxDay))].sort((a, b) => a - b);
}

function buildBaselineSnapshot(replay) {
  const claims = replay.claims.map((c) => ({
    user: c.user,
    claimDay: c.claimDay,
    termDays: c.termDays,
    settleDay: c.settleDay,
    cRank: c.cRank,
    rankDelta: c.rankDelta,
    penaltyPct: c.penaltyPct,
    grossReward: c.grossReward,
    netReward: c.netReward,
  }));

  const stakes = replay.stakes.map((s) => ({
    user: s.user,
    day: s.day,
    termDays: s.termDays,
    withdrawDay: s.withdrawDay,
    apyBps: s.apyBps,
    matured: s.matured,
    reward: s.reward,
    payout: s.payout,
  }));

  const maxDay = replay.timeline[replay.timeline.length - 1]?.day || 0;
  const byDay = new Map(replay.timeline.map((r) => [r.day, r]));
  const checkpoints = checkpointDays(maxDay).map((d) => {
    const row = byDay.get(d) || {};
    return {
      day: d,
      globalRank: row.globalRank ?? null,
      amp: row.amp ?? null,
      apyBps: row.apyBps ?? null,
      eaaBpsAtCurrentRank: row.eaaBpsAtCurrentRank ?? null,
      maxTermDaysAtCurrentRank: row.maxTermDaysAtCurrentRank ?? null,
    };
  });

  return {
    schemaVersion: 1,
    scenarioName: replay.scenarioName,
    finalGlobalRank: replay.finalGlobalRank,
    totals: {
      claimCount: claims.length,
      stakeCount: stakes.length,
      grossClaimReward: claims.reduce((n, c) => n + c.grossReward, 0),
      netClaimReward: claims.reduce((n, c) => n + c.netReward, 0),
      totalStakeReward: stakes.reduce((n, s) => n + s.reward, 0),
    },
    claims,
    stakes,
    checkpoints,
  };
}

function collectDiffs(expected, actual, currentPath = 'root', diffs = [], maxDiffs = 80) {
  if (diffs.length >= maxDiffs) return diffs;

  const expType = Array.isArray(expected) ? 'array' : typeof expected;
  const actType = Array.isArray(actual) ? 'array' : typeof actual;

  if (expType !== actType) {
    diffs.push(`${currentPath}: type mismatch expected=${expType}, actual=${actType}`);
    return diffs;
  }

  if (expType === 'array') {
    if (expected.length !== actual.length) {
      diffs.push(`${currentPath}: length mismatch expected=${expected.length}, actual=${actual.length}`);
    }
    const len = Math.min(expected.length, actual.length);
    for (let i = 0; i < len; i += 1) {
      collectDiffs(expected[i], actual[i], `${currentPath}[${i}]`, diffs, maxDiffs);
      if (diffs.length >= maxDiffs) return diffs;
    }
    return diffs;
  }

  if (expType === 'object' && expected !== null && actual !== null) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    for (const key of keys) {
      if (!(key in expected)) {
        diffs.push(`${currentPath}.${key}: missing in expected`);
        if (diffs.length >= maxDiffs) return diffs;
        continue;
      }
      if (!(key in actual)) {
        diffs.push(`${currentPath}.${key}: missing in actual`);
        if (diffs.length >= maxDiffs) return diffs;
        continue;
      }
      collectDiffs(expected[key], actual[key], `${currentPath}.${key}`, diffs, maxDiffs);
      if (diffs.length >= maxDiffs) return diffs;
    }
    return diffs;
  }

  if (expected !== actual) {
    diffs.push(`${currentPath}: expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  }

  return diffs;
}

function checkInvariants(replay) {
  const violations = [];

  for (const c of replay.claims || []) {
    if (c.penaltyPct < 0 || c.penaltyPct > 99) {
      violations.push(`claim(${c.user},rank=${c.cRank}): penalty out of bounds ${c.penaltyPct}`);
    }
    if (c.netReward < 0 || c.grossReward < 0) {
      violations.push(`claim(${c.user},rank=${c.cRank}): negative reward gross=${c.grossReward} net=${c.netReward}`);
    }
    if (c.netReward > c.grossReward) {
      violations.push(`claim(${c.user},rank=${c.cRank}): net > gross (${c.netReward} > ${c.grossReward})`);
    }
    if (c.rankDelta < 1) {
      violations.push(`claim(${c.user},rank=${c.cRank}): rankDelta < 1 (${c.rankDelta})`);
    }
  }

  for (const s of replay.stakes || []) {
    if (s.apyBps < APY_MIN_BPS || s.apyBps > APY_START_BPS) {
      violations.push(`stake(${s.user},day=${s.day}): apy out of bounds ${s.apyBps}`);
    }
    if (s.reward < 0 || s.payout < 0) {
      violations.push(`stake(${s.user},day=${s.day}): negative reward/payout`);
    }
    if (s.payout < Number(s.principal || 0)) {
      violations.push(`stake(${s.user},day=${s.day}): payout below principal`);
    }
    if (!s.matured && s.reward !== 0) {
      violations.push(`stake(${s.user},day=${s.day}): early withdraw has non-zero reward ${s.reward}`);
    }
  }

  const timeline = replay.timeline || [];
  for (let i = 0; i < timeline.length; i += 1) {
    const row = timeline[i];
    if (row.amp < 1 || row.amp > AMP_START) {
      violations.push(`timeline(day=${row.day}): amp out of bounds ${row.amp}`);
    }
    if (row.apyBps < APY_MIN_BPS || row.apyBps > APY_START_BPS) {
      violations.push(`timeline(day=${row.day}): apy out of bounds ${row.apyBps}`);
    }
    if (row.eaaBpsAtCurrentRank < 0 || row.eaaBpsAtCurrentRank > EAA_START_BPS) {
      violations.push(`timeline(day=${row.day}): eaa out of bounds ${row.eaaBpsAtCurrentRank}`);
    }
    if (row.maxTermDaysAtCurrentRank < 100) {
      violations.push(`timeline(day=${row.day}): maxTerm below 100 (${row.maxTermDaysAtCurrentRank})`);
    }

    if (i > 0) {
      const prev = timeline[i - 1];
      if (row.day <= prev.day) {
        violations.push(`timeline index ${i}: non-increasing day ${row.day} <= ${prev.day}`);
      }
      if (row.globalRank < prev.globalRank) {
        violations.push(`timeline(day=${row.day}): globalRank decreased ${row.globalRank} < ${prev.globalRank}`);
      }
      if (row.amp > prev.amp) {
        violations.push(`timeline(day=${row.day}): amp increased ${row.amp} > ${prev.amp}`);
      }
      if (row.apyBps > prev.apyBps) {
        violations.push(`timeline(day=${row.day}): apy increased ${row.apyBps} > ${prev.apyBps}`);
      }
    }
  }

  return violations;
}

function resolveBaselinePath(explicitPath, scenarioName) {
  if (explicitPath) return path.resolve(explicitPath);
  const safe = String(scenarioName || 'default').replace(/[^a-zA-Z0-9._-]+/g, '-');
  return path.resolve('xen-iota-move', 'baselines', `${safe}.baseline.json`);
}

(function main() {
  const { config, baseline, writeBaseline, checkBaseline, assertInvariants } = parseArgs();
  const scenario = loadScenario(config);

  const { claimsState, settled, finalGlobalRank } = simulateClaims(scenario.claims || []);
  const stakes = simulateStakes(scenario.stakes || []);

  const maxDay = Math.max(
    365,
    ...claimsState.map((c) => c.settleDay ?? c.maturityDay),
    ...stakes.map((s) => s.withdrawDay ?? s.maturityDay),
  );

  const timeline = buildTimeline(maxDay, claimsState);

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const reportDir = path.resolve('xen-iota-move', 'reports', `sim-${ts}`);
  ensureDir(reportDir);

  const replay = {
    generatedAt: new Date().toISOString(),
    scenarioName: scenario.name || 'unnamed',
    finalGlobalRank,
    claims: settled,
    stakes,
    timeline,
  };

  fs.writeFileSync(path.join(reportDir, 'replay.json'), JSON.stringify(replay, null, 2));
  fs.writeFileSync(path.join(reportDir, 'timeline.csv'), toCsv(timeline));
  fs.writeFileSync(path.join(reportDir, 'claims.csv'), toCsv(settled));
  fs.writeFileSync(path.join(reportDir, 'stakes.csv'), toCsv(stakes));
  fs.writeFileSync(path.join(reportDir, 'summary.md'), buildSummaryMd(scenario.name || 'unnamed', settled, stakes, timeline));

  const baselineSnapshot = buildBaselineSnapshot(replay);
  fs.writeFileSync(path.join(reportDir, 'baseline.current.json'), JSON.stringify(baselineSnapshot, null, 2));

  const baselinePath = resolveBaselinePath(baseline, scenario.name || 'default');

  if (writeBaseline) {
    ensureDir(path.dirname(baselinePath));
    fs.writeFileSync(baselinePath, JSON.stringify(baselineSnapshot, null, 2));
    console.log(`Baseline written: ${baselinePath}`);
  }

  if (checkBaseline) {
    if (!fs.existsSync(baselinePath)) {
      console.error(`Baseline missing: ${baselinePath}`);
      process.exitCode = 2;
    } else {
      const expected = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
      const diffs = collectDiffs(expected, baselineSnapshot);
      if (diffs.length === 0) {
        console.log(`Baseline check: PASS (${baselinePath})`);
      } else {
        console.error(`Baseline check: FAIL (${baselinePath})`);
        for (const d of diffs) console.error(`  - ${d}`);
        process.exitCode = 2;
      }
    }
  }

  if (assertInvariants) {
    const violations = checkInvariants(replay);
    fs.writeFileSync(path.join(reportDir, 'invariants.json'), JSON.stringify({ violations }, null, 2));

    if (violations.length === 0) {
      console.log('Invariant check: PASS');
    } else {
      console.error('Invariant check: FAIL');
      for (const v of violations) console.error(`  - ${v}`);
      process.exitCode = 2;
    }
  }

  console.log(`Simulation complete: ${reportDir}`);
})();
