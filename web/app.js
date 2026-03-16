const intFmt = new Intl.NumberFormat();
const pctFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

const fmt = (n) => intFmt.format(Number(n || 0));
const fmtPct = (n) => `${pctFmt.format(Number(n || 0))}%`;

const DEATH_WALLET_ADDRESS = window.XENFORGE_DEATH_WALLET || 'TBD (pending publish)';

const CHAIN_CONFIG = {
  rpcUrl: window.ZENFORGE_RPC_URL || 'https://api.testnet.iota.cafe',
  protocolId:
    window.ZENFORGE_PROTOCOL_ID ||
    '0xdbae4eb086afd1448d41306a5ad9c29fa48d802ace9d29dab857b543ee8e0c6f',
  packageId:
    window.ZENFORGE_PACKAGE_ID ||
    '0xa77f492c82c6f886801067a7b4a7c2eafe26b1f165ec2ae77539464d57ff2567',
  networkLabel: window.ZENFORGE_NETWORK || 'testnet',
};

const NANO = 1_000_000_000n;

const formatToken = (raw, decimals = 18) => {
  try {
    const v = BigInt(String(raw || '0'));
    const base = 10n ** BigInt(decimals);
    const whole = v / base;
    const frac = v % base;
    if (frac === 0n) return whole.toString();
    const s = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
    return `${whole.toString()}.${s}`;
  } catch {
    return String(raw || '0');
  }
};

const kpiEl = (label, value, small = false) => `
  <article class="kpi">
    <div class="label">${label}</div>
    <div class="value ${small ? 'small' : ''}">${value}</div>
  </article>
`;

const scenarioLabel = (name) =>
  String(name || '')
    .replace(/^attack-/, '')
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

async function rpcCall(method, params) {
  const res = await fetch(CHAIN_CONFIG.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });

  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const payload = await res.json();
  if (payload.error) throw new Error(payload.error.message || JSON.stringify(payload.error));
  return payload.result;
}

function computeAmpNow(nowMs, genesisMs) {
  const dayMs = 86_400_000;
  const ampStart = 3000;
  const daysSince = nowMs > genesisMs ? Math.floor((nowMs - genesisMs) / dayMs) : 0;
  if (daysSince >= ampStart - 1) return 1;
  return ampStart - daysSince;
}

function computeApyNowBps(nowMs, genesisMs) {
  const dayMs = 86_400_000;
  const apyStart = 2000;
  const apyMin = 200;
  const daysSince = nowMs > genesisMs ? Math.floor((nowMs - genesisMs) / dayMs) : 0;
  const decay = Math.floor(daysSince / 90) * 100;
  if (decay >= apyStart - apyMin) return apyMin;
  return apyStart - decay;
}

async function fetchOnchainState() {
  const result = await rpcCall('iota_getObject', [
    CHAIN_CONFIG.protocolId,
    { showContent: true, showType: true },
  ]);

  const fields = result?.data?.content?.fields;
  if (!fields) throw new Error('Protocol object content unavailable');

  const nowMs = Date.now();
  const genesisMs = Number(fields.genesis_ts_ms || 0);
  const globalRank = Number(fields.global_rank || 0);

  const packageFromType = String(result?.data?.type || '').split('::')[0] || CHAIN_CONFIG.packageId;

  return {
    ok: true,
    network: CHAIN_CONFIG.networkLabel,
    rpcUrl: CHAIN_CONFIG.rpcUrl,
    protocolId: CHAIN_CONFIG.protocolId,
    packageId: packageFromType,
    globalRank,
    maxTerm: freeMintTermLimitForRank(globalRank),
    amp: computeAmpNow(nowMs, genesisMs),
    apyBps: computeApyNowBps(nowMs, genesisMs),
    activeMints: Number(fields?.active_mints?.fields?.size || 0),
    activeStakes: Number(fields?.active_stakes?.fields?.size || 0),
    totalSupplyRaw: String(fields?.treasury?.fields?.total_supply?.fields?.value || '0'),
    totalSupplyDisplay: formatToken(fields?.treasury?.fields?.total_supply?.fields?.value || '0', 18),
    asOf: new Date(nowMs).toISOString(),
  };
}

const walletState = {
  api: null,
  wallets: [],
  currentWallet: null,
  account: null,
  silentAttempted: false,
};

const shortAddress = (addr) => {
  const s = String(addr || '');
  if (s.length <= 16) return s;
  return `${s.slice(0, 8)}...${s.slice(-6)}`;
};

function updateWalletUi(message) {
  const statusEl = document.querySelector('#walletStatus');
  const addrEl = document.querySelector('#connectedAddress');
  const connectBtn = document.querySelector('#connectWalletBtn');
  const disconnectBtn = document.querySelector('#disconnectWalletBtn');

  if (statusEl && message) statusEl.textContent = message;
  if (addrEl) addrEl.textContent = walletState.account?.address || '-';
  if (connectBtn) connectBtn.disabled = !walletState.wallets.length;
  if (disconnectBtn) disconnectBtn.disabled = !walletState.currentWallet;
}

function renderWalletSelect() {
  const select = document.querySelector('#walletSelect');
  if (!select) return;

  const currentName = select.value;
  select.innerHTML = '';

  if (!walletState.wallets.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No compatible wallet detected';
    select.appendChild(opt);
    updateWalletUi('No compatible IOTA wallet found. Open/install your wallet extension, then refresh.');
    return;
  }

  for (const w of walletState.wallets) {
    const opt = document.createElement('option');
    opt.value = w.name;
    opt.textContent = w.name;
    select.appendChild(opt);
  }

  const fallback = walletState.wallets[0]?.name || '';
  select.value = walletState.wallets.some((w) => w.name === currentName) ? currentName : fallback;
}

function getSelectedWallet() {
  const select = document.querySelector('#walletSelect');
  if (!select) return null;
  const name = select.value;
  return walletState.wallets.find((w) => w.name === name) || null;
}

async function connectWallet(wallet, silent = false) {
  if (!wallet) throw new Error('Select a wallet first.');
  const connectFeature = wallet.features?.['standard:connect'];
  if (!connectFeature?.connect) throw new Error(`${wallet.name} does not support standard:connect.`);

  const result = await connectFeature.connect(silent ? { silent: true } : undefined);
  const account = result?.accounts?.[0] || wallet.accounts?.[0];
  if (!account) throw new Error(`No account returned by ${wallet.name}.`);

  walletState.currentWallet = wallet;
  walletState.account = account;
  localStorage.setItem('xenforge.wallet', wallet.name);

  updateWalletUi(`Connected: ${wallet.name} · ${shortAddress(account.address)}`);
}

async function disconnectWallet() {
  const wallet = walletState.currentWallet;
  if (!wallet) return;

  try {
    const disconnectFeature = wallet.features?.['standard:disconnect'];
    if (disconnectFeature?.disconnect) await disconnectFeature.disconnect();
  } finally {
    walletState.currentWallet = null;
    walletState.account = null;
    localStorage.removeItem('xenforge.wallet');
    updateWalletUi('Wallet disconnected.');
  }
}

async function setupWalletConnection() {
  const select = document.querySelector('#walletSelect');
  const connectBtn = document.querySelector('#connectWalletBtn');
  const disconnectBtn = document.querySelector('#disconnectWalletBtn');

  if (!select || !connectBtn || !disconnectBtn) return;

  updateWalletUi('Loading wallet connection module...');

  let getWallets;
  try {
    ({ getWallets } = await import('https://esm.sh/@wallet-standard/app@1.1.0'));
  } catch (err) {
    updateWalletUi('Wallet loader unavailable. Check internet/extension and refresh.');
    console.error('Wallet standard import failed:', err);
    return;
  }

  walletState.api = getWallets();

  const refreshWallets = async () => {
    const all = walletState.api.get() || [];
    walletState.wallets = all.filter((w) => Array.from(w.chains || []).some((c) => String(c).startsWith('iota:')));
    renderWalletSelect();

    if (!walletState.wallets.length) {
      walletState.currentWallet = null;
      walletState.account = null;
      updateWalletUi('No compatible IOTA wallet found. Open/install your wallet extension, then refresh.');
      return;
    }

    updateWalletUi(walletState.currentWallet ? `Connected: ${shortAddress(walletState.account?.address)}` : 'Wallet detected. Choose one and connect.');

    if (!walletState.silentAttempted) {
      walletState.silentAttempted = true;
      const preferred = localStorage.getItem('xenforge.wallet');
      if (preferred) {
        const wallet = walletState.wallets.find((w) => w.name === preferred);
        if (wallet) {
          try {
            await connectWallet(wallet, true);
          } catch {
            // silent connect can fail if authorization expired; user can reconnect manually.
          }
        }
      }
    }
  };

  walletState.api.on('register', refreshWallets);
  walletState.api.on('unregister', refreshWallets);

  connectBtn.addEventListener('click', async () => {
    const wallet = getSelectedWallet();
    if (!wallet) {
      updateWalletUi('Select a wallet first.');
      return;
    }

    updateWalletUi(`Connecting to ${wallet.name}...`);
    try {
      await connectWallet(wallet, false);
    } catch (err) {
      updateWalletUi(`Connection failed: ${err?.message || err}`);
    }
  });

  disconnectBtn.addEventListener('click', async () => {
    await disconnectWallet();
  });

  await refreshWallets();
}

function renderHeroStage(data) {
  const scenario = data.defaultScenario || {};
  const t = scenario.totals || {};

  document.querySelector('#stamp').textContent = `Last refresh: ${new Date(data.generatedAt).toLocaleString()} • scenario: ${scenario.name || 'default'}`;
  document.querySelector('#heroFinalRank').textContent = fmt(scenario.finalGlobalRank);
  document.querySelector('#heroGross').textContent = fmt(t.grossClaimReward);
  document.querySelector('#heroNet').textContent = fmt(t.netClaimReward);
  document.querySelector('#heroMatured').textContent = fmt(t.maturedStakes);

  const liveContext = document.querySelector('#liveContext');
  if (liveContext) {
    liveContext.textContent = `Baseline scenario: ${scenario.name || 'default'}`;
  }
}

function renderKpis(data, onchain) {
  const t = data.defaultScenario?.totals || {};

  const primary = [
    kpiEl('Network Position', fmt(onchain?.globalRank ?? data.defaultScenario?.finalGlobalRank)),
    kpiEl('Current AMP', fmt(onchain?.amp ?? 0)),
    kpiEl('Current APY (bps)', fmt(onchain?.apyBps ?? 0)),
    kpiEl('Max Term (days)', fmt(onchain?.maxTerm ?? freeMintTermLimitForRank(data.defaultScenario?.finalGlobalRank || 0))),
  ].join('');

  const secondary = [
    kpiEl('Total Claims', fmt(t.claims)),
    kpiEl('Total Stakes', fmt(t.stakes)),
  ].join('');

  document.querySelector('#kpis').innerHTML = primary;
  const more = document.querySelector('#kpisMore');
  if (more) more.innerHTML = secondary;
}

function renderLiveMetricReadback(data, onchain) {
  const scenario = data.defaultScenario || {};
  const timeline = scenario.timelineSample || [];
  const latest = timeline[timeline.length - 1] || {};

  const setText = (id, text) => {
    const el = document.querySelector(id);
    if (el) el.textContent = text;
  };

  const setSource = (id, text) => {
    const el = document.querySelector(id);
    if (el) el.textContent = text;
  };

  if (onchain?.ok) {
    setText('#liveMetricRank', `${fmt(onchain.globalRank)} participants/rank`);
    setText('#liveMetricMaxTerm', `${fmt(onchain.maxTerm)} days`);
    setText('#liveMetricAmp', fmt(onchain.amp));
    setText('#liveMetricApy', `${fmt(onchain.apyBps)} bps`);
    setText('#liveMetricActiveMints', fmt(onchain.activeMints));
    setText('#liveMetricActiveStakes', fmt(onchain.activeStakes));
    setText('#liveMetricSupply', onchain.totalSupplyDisplay);
    setText('#liveMetricContract', onchain.packageId);
    setText('#liveMetricProtocol', onchain.protocolId);
    setText('#liveMetricRpc', onchain.rpcUrl);
    setText('#liveMetricPenaltyState', 'Per-receipt (evaluate at claim time)');

    setSource('#liveSourceRank', `Live on-chain (${onchain.network})`);
    setSource('#liveSourceMaxTerm', 'Contract formula from live rank');
    setSource('#liveSourceAmp', `Contract formula from live genesis time`);
    setSource('#liveSourceApy', `Contract formula from live genesis time`);
    setSource('#liveSourceActiveMints', 'Live on-chain table size');
    setSource('#liveSourceActiveStakes', 'Live on-chain table size');
    setSource('#liveSourceSupply', 'Live treasury total_supply');
    setSource('#liveSourceContract', 'Derived from protocol object type');
    setSource('#liveSourceProtocol', 'Runtime config');
    setSource('#liveSourceRpc', 'Runtime config');
  } else {
    const rank = Number(scenario.finalGlobalRank || 0);
    const maxTerm = freeMintTermLimitForRank(rank);

    setText('#liveMetricRank', `${fmt(rank)} participants/rank`);
    setText('#liveMetricMaxTerm', `${fmt(maxTerm)} days`);
    setText('#liveMetricAmp', latest.amp != null ? String(latest.amp) : 'N/A');
    setText('#liveMetricApy', latest.apyBps != null ? `${fmt(latest.apyBps)} bps` : 'N/A');
    setText('#liveMetricActiveMints', 'N/A');
    setText('#liveMetricActiveStakes', 'N/A');
    setText('#liveMetricSupply', 'N/A');
    setText('#liveMetricContract', CHAIN_CONFIG.packageId || 'Not set');
    setText('#liveMetricProtocol', CHAIN_CONFIG.protocolId || 'Not set');
    setText('#liveMetricRpc', CHAIN_CONFIG.rpcUrl || 'Not set');

    setSource('#liveSourceRank', 'Simulation fallback');
    setSource('#liveSourceMaxTerm', 'Computed from simulation rank');
    setSource('#liveSourceAmp', 'Simulation fallback');
    setSource('#liveSourceApy', 'Simulation fallback');
    setSource('#liveSourceActiveMints', 'Unavailable (on-chain read failed)');
    setSource('#liveSourceActiveStakes', 'Unavailable (on-chain read failed)');
    setSource('#liveSourceSupply', 'Unavailable (on-chain read failed)');
    setSource('#liveSourceContract', 'Runtime config');
    setSource('#liveSourceProtocol', 'Runtime config');
    setSource('#liveSourceRpc', 'Runtime config');
  }
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function floorLog2(x) {
  let v = Math.max(1, Math.floor(Number(x || 1)));
  let n = 0;
  while (v > 1) {
    v = Math.floor(v / 2);
    n += 1;
  }
  return n;
}

function freeMintTermLimitForRank(globalRank) {
  const r = Math.max(1, Math.floor(Number(globalRank || 1)));
  if (r <= 5000) return 100;
  return 100 + floorLog2(r) * 15;
}

function feeAtTerm(day, minFee, maxFee, maxTerm = 365) {
  if (maxTerm <= 1) return minFee;
  return minFee + ((maxFee - minFee) * (maxTerm - day)) / (maxTerm - 1);
}

function eaaForRank(rank) {
  return Math.max(0.1 - 0.001 * Math.floor(rank / 100000), 0);
}

function rewardScore(globalRank, userRank, termDays) {
  const rankDelta = Math.max(1, globalRank - userRank);
  const eaa = eaaForRank(userRank);
  return {
    rankDelta,
    eaa,
    score: Math.log2(rankDelta) * termDays * (1 + eaa),
  };
}

function renderFeeSimulatorChart(data, onchain) {
  const minInput = document.querySelector('#simMinFee');
  const maxInput = document.querySelector('#simMaxFee');
  const globalInput = document.querySelector('#simGlobalRank');
  const userInput = document.querySelector('#simUserRank');
  const termInput = document.querySelector('#simTermDays');
  const summary = document.querySelector('#simSummary');
  const rankSummary = document.querySelector('#rankSummary');
  const walletEl = document.querySelector('#deathWalletAddress');
  const feeBreakdown = document.querySelector('#feeBreakdown');
  const feeMinNote = document.querySelector('#feeMinNote');
  const feeSelectableNote = document.querySelector('#feeSelectableNote');

  if (!minInput || !maxInput || !globalInput || !userInput || !termInput || !feeBreakdown) return;

  const defaultGlobalRank = Number(onchain?.globalRank ?? data?.defaultScenario?.finalGlobalRank ?? 100000);
  globalInput.value = String(Math.max(1, Math.floor(defaultGlobalRank)));
  userInput.value = String(Math.max(1, Math.floor(defaultGlobalRank - 1000)));

  if (walletEl) walletEl.textContent = DEATH_WALLET_ADDRESS;

  const update = () => {
    let minFee = clampNumber(minInput.value, 0, 1_000_000, 0.005);
    let maxFee = clampNumber(maxInput.value, 0, 1_000_000, 0.05);

    let globalRank = Math.max(1, Math.floor(clampNumber(globalInput.value, 1, 1_000_000_000_000, defaultGlobalRank)));
    let userRank = Math.max(1, Math.floor(clampNumber(userInput.value, 1, 1_000_000_000_000, Math.max(1, defaultGlobalRank - 1000))));
    const termDays = Math.max(1, Math.floor(clampNumber(termInput.value, 1, 365, 100)));

    if (maxFee < minFee) {
      const tmp = maxFee;
      maxFee = minFee;
      minFee = tmp;
      minInput.value = String(minFee);
      maxInput.value = String(maxFee);
    }

    if (userRank >= globalRank) {
      globalRank = userRank + 1;
      globalInput.value = String(globalRank);
    }

    const avgFee = (minFee + maxFee) / 2;
    const now = rewardScore(globalRank, userRank, termDays);
    const later = rewardScore(globalRank + 100000, userRank + 100000, termDays);
    const scoreLiftPct = later.score > 0 ? ((now.score - later.score) / later.score) * 100 : 0;
    const currentMaxSelectableTerm = freeMintTermLimitForRank(globalRank);

    const checkpoints = [1, 7, 30, 90, 180, 356, 365]
      .map((d) => kpiEl(`Day ${d} fee`, `${feeAtTerm(d, minFee, maxFee, 365).toFixed(4)} IOTA`, true))
      .join('');
    feeBreakdown.innerHTML = checkpoints;

    if (summary) {
      summary.textContent = `Short-term claim fee (Day 1): ${maxFee.toFixed(4)} IOTA • Long-term claim fee (Day 365): ${minFee.toFixed(4)} IOTA • Avg fee: ${avgFee.toFixed(4)} IOTA`;
    }

    if (feeMinNote) {
      feeMinNote.textContent = 'Minimum-fee term in current calculator model: Day 365 (not Day 356).';
    }

    if (feeSelectableNote) {
      const canPick356 = currentMaxSelectableTerm >= 356;
      const canPick365 = currentMaxSelectableTerm >= 365;
      feeSelectableNote.textContent = `Selectable term limit at current rank: ${fmt(currentMaxSelectableTerm)} days • Day 356 selectable: ${canPick356 ? 'yes' : 'no'} • Day 365 selectable: ${canPick365 ? 'yes' : 'no'}`;
    }

    if (rankSummary) {
      rankSummary.textContent = `Your rank: ${fmt(userRank)} • Rank delta: ${fmt(now.rankDelta)} • Early-rank bonus (EAA): ${fmtPct(now.eaa * 100)} • Relative reward score vs +100k later cohort: ${fmtPct(scoreLiftPct)}`;
    }
  };

  ['input', 'change'].forEach((evt) => {
    minInput.addEventListener(evt, update);
    maxInput.addEventListener(evt, update);
    globalInput.addEventListener(evt, update);
    userInput.addEventListener(evt, update);
    termInput.addEventListener(evt, update);
  });

  update();
}

function renderScenarioTable(data) {
  const rowsEl = document.querySelector('#scenarioRows');
  if (!rowsEl) return;

  const cards = data.attackCards || [];
  const rows = cards
    .map((c) => {
      const driftClass = Number(c.driftPct) <= 0 ? 'good' : 'bad';
      return `
        <tr>
          <td>${scenarioLabel(c.scenarioName)}</td>
          <td>${fmt(c.totalNet)}</td>
          <td>${fmt(c.totalStakeReward)}</td>
          <td>${fmtPct(c.avgPenalty)}</td>
          <td class="attack-drift ${driftClass}">${fmtPct(c.driftPct)}</td>
        </tr>
      `;
    })
    .join('');

  rowsEl.innerHTML = rows || '<tr><td colspan="5">No scenario rows yet.</td></tr>';
}

function renderClaims(data) {
  const rows = data.defaultScenario?.topClaims || [];
  const html = rows
    .map(
      (r) => `
      <tr>
        <td>${r.user}</td>
        <td>${fmt(r.cRank)}</td>
        <td>${fmt(r.netReward)}</td>
        <td>${fmt(r.grossReward)}</td>
        <td>${fmtPct(r.penaltyPct)}</td>
        <td>${fmt(r.settleDay)}</td>
      </tr>
    `,
    )
    .join('');

  document.querySelector('#claimsRows').innerHTML = html;
}

async function main() {
  const res = await fetch('./data/latest.json');
  if (!res.ok) throw new Error('Missing ./data/latest.json. Run: node xen-iota-move/scripts/build-web-data.mjs');
  const data = await res.json();

  let onchain = null;
  try {
    onchain = await fetchOnchainState();
  } catch (err) {
    console.warn('On-chain metric read failed, using simulation fallback:', err);
  }

  renderHeroStage(data);
  renderKpis(data, onchain);
  renderLiveMetricReadback(data, onchain);
  renderFeeSimulatorChart(data, onchain);
  renderScenarioTable(data);
  renderClaims(data);
  await setupWalletConnection();
}

main().catch((err) => {
  console.error(err);
  const stamp = document.querySelector('#stamp');
  if (stamp) stamp.textContent = String(err.message || err);
});
