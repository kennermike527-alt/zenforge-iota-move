const fmt = (n) => new Intl.NumberFormat().format(Number(n || 0));

const CHAIN_CONFIG = {
  rpcUrl: window.ZENFORGE_RPC_URL || 'https://api.testnet.iota.cafe',
  protocolId:
    window.ZENFORGE_PROTOCOL_ID ||
    '0xdbae4eb086afd1448d41306a5ad9c29fa48d802ace9d29dab857b543ee8e0c6f',
  packageId:
    window.ZENFORGE_PACKAGE_ID ||
    '0xa77f492c82c6f886801067a7b4a7c2eafe26b1f165ec2ae77539464d57ff2567',
  clockId: window.ZENFORGE_CLOCK_ID || '0x6',
  networkLabel: window.ZENFORGE_NETWORK || 'testnet',
};

function setText(id, text) {
  const el = document.querySelector(id);
  if (el) el.textContent = text;
}

const DAY_MS = 86_400_000;
const CHAIN_ID = `iota:${CHAIN_CONFIG.networkLabel}`;
const TOKEN_DECIMALS = Number(window.ZENFORGE_TOKEN_DECIMALS || 18);
const U64_MAX = 18_446_744_073_709_551_615n;
const BASE_MIN_FEE = Number(window.ZENFORGE_BASE_MIN_FEE || 0.005);
const BASE_MAX_FEE = Number(window.ZENFORGE_BASE_MAX_FEE || 0.05);
const WALLET_DOWNLOAD_URL =
  'https://chromewebstore.google.com/detail/iota-wallet/iidjkmdceolghepehaaddojmnjnkkija';
const WALLET_AUTO_KEY = 'xenforgeWalletAutoconnect';
const WALLET_PREF_KEY = 'xenforgeWalletPreferredName';
const APP_STATE = {
  protocol: null,
  walletSession: null,
  activeMintReceipt: null,
  activeMintReceipts: [],
  stakeCoins: [],
  stakeReceipts: [],
};

function fmtDec(n, max = 6) {
  return Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: max });
}

function parseUnits(rawText, decimals = TOKEN_DECIMALS) {
  const v = String(rawText || '').trim();
  if (!v) return null;
  if (!/^(?:\d+|\d*\.\d+)$/.test(v)) return null;

  const [whole, frac = ''] = v.split('.');
  const wholeSafe = whole === '' ? '0' : whole;
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  try {
    return BigInt(wholeSafe) * 10n ** BigInt(decimals) + BigInt(fracPadded || '0');
  } catch {
    return null;
  }
}

function formatUnits(rawValue, decimals = TOKEN_DECIMALS, maxFrac = 6) {
  try {
    const raw = BigInt(rawValue || 0);
    const base = 10n ** BigInt(decimals);
    const whole = raw / base;
    const frac = raw % base;

    if (frac === 0n) return whole.toString();

    let fracText = frac.toString().padStart(decimals, '0');
    fracText = fracText.slice(0, Math.max(0, maxFrac)).replace(/0+$/, '');
    return fracText ? `${whole.toString()}.${fracText}` : whole.toString();
  } catch {
    return '0';
  }
}

function estimateStakeReward(principal, apyBps, termDays) {
  return (Number(principal || 0) * Number(apyBps || 0) * Number(termDays || 0)) / 10000 / 365;
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

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function feeAtTerm(day, minFee, maxFee, maxTerm = 365) {
  return minFee + ((maxFee - minFee) * (maxTerm - day)) / (maxTerm - 1);
}

function hardLockedFeeFromCRank(cRank, termDays, globalRank) {
  const gRank = Math.max(1, Math.floor(Number(globalRank || 1)));
  const c = clamp(Math.floor(Number(cRank || gRank)), 1, gRank);
  const d = clamp(Math.floor(Number(termDays || 1)), 1, 365);

  const baseFee = feeAtTerm(d, BASE_MIN_FEE, BASE_MAX_FEE);
  const multiplier = 0.8 + 0.4 * (c / gRank);
  return {
    cRank: c,
    day: d,
    baseFee,
    multiplier,
    fee: baseFee * multiplier,
  };
}

function latePenaltyPct(daysLate) {
  if (daysLate <= 0) return 0;
  if (daysLate === 1) return 1;
  if (daysLate === 2) return 3;
  if (daysLate === 3) return 8;
  if (daysLate === 4) return 17;
  if (daysLate === 5) return 35;
  if (daysLate === 6) return 72;
  return 99;
}

function computeAmpNow(nowMs, genesisMs) {
  const dayMs = 86_400_000;
  const ampStart = 3000;
  const daysSince = nowMs > genesisMs ? Math.floor((nowMs - genesisMs) / dayMs) : 0;
  return daysSince >= ampStart - 1 ? 1 : ampStart - daysSince;
}

function computeApyNowBps(nowMs, genesisMs) {
  const dayMs = 86_400_000;
  const apyStart = 2000;
  const apyMin = 200;
  const daysSince = nowMs > genesisMs ? Math.floor((nowMs - genesisMs) / dayMs) : 0;
  const decay = Math.floor(daysSince / 90) * 100;
  return decay >= apyStart - apyMin ? apyMin : apyStart - decay;
}

async function rpcCall(method, params) {
  const res = await fetch(CHAIN_CONFIG.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || JSON.stringify(body.error));
  return body.result;
}

async function fetchOnchainState() {
  const result = await rpcCall('iota_getObject', [CHAIN_CONFIG.protocolId, { showContent: true, showType: true }]);
  const fields = result?.data?.content?.fields;
  if (!fields) throw new Error('Protocol object content unavailable');

  const now = Date.now();
  const genesisMs = Number(fields.genesis_ts_ms || 0);
  const globalRank = Number(fields.global_rank || 0);
  const packageFromType = String(result?.data?.type || '').split('::')[0] || CHAIN_CONFIG.packageId;

  return {
    source: 'live',
    packageId: packageFromType,
    globalRank,
    maxTerm: freeMintTermLimitForRank(globalRank),
    amp: computeAmpNow(now, genesisMs),
    apyBps: computeApyNowBps(now, genesisMs),
  };
}

function renderSnapshot(state, sourceLabel) {
  setText('#metricRank', fmt(state.globalRank));
  setText('#metricMaxTerm', `${fmt(state.maxTerm)} days`);
  setText('#metricAmp', fmt(state.amp));
  setText('#metricApy', fmt(state.apyBps));
  setText('#selectableTermHint', `Right now, terms above ${fmt(state.maxTerm)} days are not selectable on-chain.`);

  const isLive = !sourceLabel.includes('FALLBACK');

  const badge = document.querySelector('#sourceBadge');
  if (badge) {
    badge.textContent = sourceLabel;
    badge.classList.remove('live', 'fallback');
    badge.classList.add(isLive ? 'live' : 'fallback');
  }

  const fetchBar = document.querySelector('#liveFetchBar');
  const fetchText = document.querySelector('#liveFetchText');
  if (fetchBar && fetchText) {
    fetchBar.classList.remove('checking', 'live', 'fallback');
    fetchBar.classList.add(isLive ? 'live' : 'fallback');
    fetchText.textContent = isLive
      ? 'Metrics currently fetched on-chain'
      : 'On-chain fetch unavailable — showing fallback data';
  }
}

function renderFeeSimulator(state) {
  const rankInput = document.querySelector('#simGlobalRank');
  const cRankInput = document.querySelector('#simCRank');
  const termInput = document.querySelector('#simTermDays');
  const ampInput = document.querySelector('#simAmp');

  const output = document.querySelector('#feeOutput');
  const formulaOutput = document.querySelector('#feeFormulaOutput');
  const feeNote = document.querySelector('#feeNote');
  const simStateNote = document.querySelector('#simStateNote');

  if (!rankInput || !cRankInput || !termInput || !ampInput || !output || !formulaOutput) return;

  // Pre-populate from current protocol state (live or fallback)
  const lockedAmp = Math.max(1, Math.floor(Number(state.amp || 3000)));
  const startRank = Math.max(1, Math.floor(Number(state.globalRank || 1)));
  rankInput.value = String(startRank);
  cRankInput.value = String(startRank);
  termInput.value = String(Math.min(100, Math.max(1, Math.floor(Number(state.maxTerm || 100)))));
  ampInput.value = String(lockedAmp);
  ampInput.readOnly = true;

  const update = () => {
    const rank = Math.max(1, Math.floor(Number(rankInput.value || 1)));
    rankInput.value = String(rank);

    const cRank = clamp(Math.floor(Number(cRankInput.value || rank)), 1, rank);
    cRankInput.value = String(cRank);

    let termDays = Math.max(1, Math.floor(Number(termInput.value || 30)));
    termDays = Math.min(100, termDays);
    termInput.value = String(termDays);

    ampInput.value = String(lockedAmp);

    const impliedMaxTerm = freeMintTermLimitForRank(rank);
    const feeModel = hardLockedFeeFromCRank(cRank, termDays, rank);

    output.innerHTML = [
      `<b>Selected term:</b> ${termDays} days`,
      `<b>Selected cRank:</b> ${fmt(cRank)}`,
      `<b>Hard-locked fee charged:</b> ${feeModel.fee.toFixed(6)} IOTA`,
      `<b>Base term fee:</b> ${feeModel.baseFee.toFixed(6)} IOTA`,
      `<b>cRank multiplier:</b> ×${feeModel.multiplier.toFixed(4)}`,
      `<b>Current simulator state:</b> rank ${fmt(rank)}, AMP ${fmt(lockedAmp)} (locked)`,
    ].join('<br/>');

    formulaOutput.innerHTML = [
      '<b>Fee formula (hard-locked policy model):</b>',
      `<code>baseFee(day) = ${BASE_MIN_FEE.toFixed(6)} + ((${BASE_MAX_FEE.toFixed(6)} - ${BASE_MIN_FEE.toFixed(6)}) × (365 - day)) / 364</code>`,
      '<code>multiplier = 0.8 + 0.4 × (cRank / globalRank)</code>',
      '<code>fee = baseFee × multiplier</code>',
      `<b>Current inputs:</b> globalRank=${fmt(rank)}, cRank=${fmt(cRank)}, day=${termDays}`,
      `<b>Computed fee:</b> ${feeModel.fee.toFixed(6)} IOTA`,
    ].join('<br/>');

    if (simStateNote) {
      simStateNote.textContent = `Formula-implied max term from rank is ${fmt(impliedMaxTerm)} days. cRank is clamped to [1, globalRank]. No manual fee override.`;
    }

    if (feeNote) feeNote.textContent = 'Fee shown here is hard-locked by cRank + selected term in this UI policy model (still not on-chain-enforced yet).';
  };

  ['input', 'change'].forEach((evt) => {
    rankInput.addEventListener(evt, update);
    cRankInput.addEventListener(evt, update);
    termInput.addEventListener(evt, update);
  });

  update();
}

function renderStakingPreview(state) {
  const apyInput = document.querySelector('#stakeApyBps');
  const amountInput = document.querySelector('#stakeAmount');
  const termInput = document.querySelector('#stakeTermDays');
  const output = document.querySelector('#stakingOutput');
  const note = document.querySelector('#stakingNote');

  if (!apyInput || !amountInput || !termInput || !output) return;

  const apyBps = Math.max(0, Math.floor(Number(state.apyBps || 0)));
  apyInput.value = String(apyBps);
  apyInput.readOnly = true;

  const update = () => {
    const principal = Math.max(0, Number(String(amountInput.value || '0').replace(/,/g, '.')) || 0);
    const termDays = Math.max(1, Math.min(1000, Math.floor(Number(termInput.value || 365))));
    termInput.value = String(termDays);

    const rate = apyBps / 10_000;
    const reward = principal * rate * (termDays / 365);
    const total = principal + reward;
    const rawApprox = parseUnits(String(principal), TOKEN_DECIMALS);

    output.innerHTML = [
      `<b>Staked principal:</b> ${fmtDec(principal)} XENI`,
      `<b>APY context:</b> ${fmt(apyBps)} bps (${(rate * 100).toFixed(2)}% yearly)`,
      `<b>Term:</b> ${fmt(termDays)} days`,
      `<b>Estimated reward:</b> ${fmtDec(reward)} XENI`,
      `<b>Estimated total at maturity:</b> ${fmtDec(total)} XENI`,
      `<b>Raw amount used on-chain:</b> ${rawApprox ? fmt(rawApprox.toString()) : '-'}`,
    ].join('<br/>');

    if (note) {
      note.textContent = 'Preview uses a simple linear estimate for readability. Stake input is in human XENI, converted to 18-decimal raw units for transaction build.';
    }
  };

  ['input', 'change'].forEach((evt) => {
    amountInput.addEventListener(evt, update);
    termInput.addEventListener(evt, update);
  });

  update();
}

function setupToolTabs() {
  const mintBtn = document.querySelector('#tabMint');
  const stakingBtn = document.querySelector('#tabStaking');
  const mintPanel = document.querySelector('#panelMint');
  const stakingPanel = document.querySelector('#panelStaking');

  if (!mintBtn || !stakingBtn || !mintPanel || !stakingPanel) return;

  const activate = (kind) => {
    const mintActive = kind === 'mint';

    mintBtn.classList.toggle('active', mintActive);
    mintBtn.setAttribute('aria-selected', mintActive ? 'true' : 'false');

    stakingBtn.classList.toggle('active', !mintActive);
    stakingBtn.setAttribute('aria-selected', mintActive ? 'false' : 'true');

    mintPanel.classList.toggle('active', mintActive);
    stakingPanel.classList.toggle('active', !mintActive);

    if (mintActive) {
      mintPanel.removeAttribute('hidden');
      stakingPanel.setAttribute('hidden', '');
    } else {
      stakingPanel.removeAttribute('hidden');
      mintPanel.setAttribute('hidden', '');
    }
  };

  mintBtn.addEventListener('click', () => activate('mint'));
  stakingBtn.addEventListener('click', () => activate('staking'));
  activate('mint');
}

function setupCursorFx() {
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  if (!finePointer) return;

  const dot = document.querySelector('#cursorDot');
  const glow = document.querySelector('#cursorGlow');
  const toggle = document.querySelector('#cursorToggle');
  if (!dot || !glow || !toggle) return;

  let enabled = localStorage.getItem('xenforgeCursorFx') !== 'off';
  let x = window.innerWidth / 2;
  let y = window.innerHeight / 2;
  let gx = x;
  let gy = y;

  const apply = () => {
    document.body.classList.toggle('cursor-fx-enabled', enabled);
    toggle.textContent = `Cursor FX: ${enabled ? 'On' : 'Off'}`;
  };

  const move = (e) => {
    x = e.clientX;
    y = e.clientY;
    if (enabled) {
      dot.style.left = `${x}px`;
      dot.style.top = `${y}px`;
    }
  };

  const tick = () => {
    if (enabled) {
      gx += (x - gx) * 0.2;
      gy += (y - gy) * 0.2;
      glow.style.left = `${gx}px`;
      glow.style.top = `${gy}px`;
    }
    requestAnimationFrame(tick);
  };

  const interactiveSel = 'a, button, input, select, textarea, summary, [role="button"]';
  const wireInteractive = () => {
    document.querySelectorAll(interactiveSel).forEach((el) => {
      if (el.dataset.cursorFxBound) return;
      el.dataset.cursorFxBound = '1';
      el.addEventListener('mouseenter', () => glow.classList.add('active'));
      el.addEventListener('mouseleave', () => glow.classList.remove('active'));
      el.addEventListener('focus', () => glow.classList.add('active'));
      el.addEventListener('blur', () => glow.classList.remove('active'));
    });
  };

  toggle.addEventListener('click', () => {
    enabled = !enabled;
    localStorage.setItem('xenforgeCursorFx', enabled ? 'on' : 'off');
    apply();
  });

  window.addEventListener('mousemove', move, { passive: true });
  wireInteractive();
  apply();
  tick();
}

async function fetchOwnedObjects(address, maxPages = 4) {
  const query = { options: { showType: true, showContent: true } };
  const objects = [];
  let cursor = null;
  let pageCount = 0;

  while (pageCount < maxPages) {
    const owned = await rpcCall('iotax_getOwnedObjects', [address, query, cursor, 50]);
    const page = owned?.data || [];
    objects.push(...page);
    pageCount += 1;

    if (!owned?.hasNextPage || !owned?.nextCursor) break;
    cursor = owned.nextCursor;
  }

  return objects;
}

async function renderStakeList(address, state) {
  const listEl = document.querySelector('#stakeList');
  const txStatus = document.querySelector('#stakeTxStatus');
  const withdrawAllBtn = document.querySelector('#withdrawAllStakesBtn');
  if (!listEl) return;

  if (!address) {
    APP_STATE.stakeReceipts = [];
    listEl.innerHTML = '<div class="stake-item">Connect wallet to view your stakes.</div>';
    if (txStatus) txStatus.textContent = '';
    if (withdrawAllBtn) withdrawAllBtn.disabled = true;
    return;
  }

  listEl.innerHTML = '<div class="stake-item">Loading stake receipts...</div>';

  try {
    const packageId = state.packageId || CHAIN_CONFIG.packageId;
    const objects = await fetchOwnedObjects(address, 6);
    const stakes = objects
      .filter((o) => String(o?.data?.type || '').endsWith('::xen::StakeReceipt'))
      .map((o) => {
        const f = o?.data?.content?.fields || {};
        const principalRaw = BigInt(String(f.principal || '0'));
        const principal = Number(formatUnits(principalRaw, TOKEN_DECIMALS, 6));
        const termDays = Number(f.term_days || 0);
        const apyBps = Number(f.apy_bps || 0);
        const maturityMs = Number(f.maturity_ts_ms || 0);
        const nowMs = Date.now();
        const matured = nowMs >= maturityMs;
        const daysToMaturity = Math.max(0, Math.ceil((maturityMs - nowMs) / DAY_MS));
        const estReward = estimateStakeReward(principal, apyBps, termDays);
        return {
          id: f?.id?.id || o?.data?.objectId || '-',
          principalRaw,
          principal,
          termDays,
          apyBps,
          maturityMs,
          matured,
          daysToMaturity,
          estReward,
          packageMatch: String(o?.data?.type || '').startsWith(String(packageId)),
        };
      });

    APP_STATE.stakeReceipts = stakes;

    if (!stakes.length) {
      listEl.innerHTML = '<div class="stake-item">No active stake receipts found.</div>';
      if (withdrawAllBtn) withdrawAllBtn.disabled = true;
      return;
    }

    listEl.innerHTML = stakes
      .map((s) => {
        const status = s.matured ? 'Matured' : `Active - ${fmt(s.daysToMaturity)} day(s) left`;
        const maturityText = new Date(s.maturityMs).toLocaleString();
        const canWithdraw = s.matured && s.packageMatch && s.id && s.id !== '-';
        const action = canWithdraw
          ? `<button class="btn primary withdraw-stake-btn" type="button" data-receipt-id="${s.id}">Withdraw</button>`
          : `<button class="btn ghost" type="button" disabled>${s.matured ? 'Withdraw unavailable' : 'Withdraw at maturity'}</button>`;

        return `
          <div class="stake-item">
            <b>Status:</b> ${status}<br/>
            <b>Principal:</b> ${fmtDec(s.principal)} XENI<br/>
            <b>Principal (raw):</b> ${fmt(s.principalRaw.toString())}<br/>
            <b>Term:</b> ${fmt(s.termDays)} days<br/>
            <b>APY:</b> ${fmt(s.apyBps)} bps<br/>
            <b>Estimated reward:</b> ${fmtDec(s.estReward)} XENI<br/>
            <b>Maturity:</b> ${maturityText}<br/>
            <b>Receipt:</b> <code>${s.id}</code>${s.packageMatch ? '' : ' <span class="claim-warn">(different package)</span>'}
            <div class="stake-item-actions">${action}</div>
          </div>
        `;
      })
      .join('');

    const maturedCount = stakes.filter((s) => s.matured && s.packageMatch && s.id && s.id !== '-').length;
    if (withdrawAllBtn) withdrawAllBtn.disabled = maturedCount === 0;
  } catch (err) {
    APP_STATE.stakeReceipts = [];
    listEl.innerHTML = `<div class="stake-item">Failed to load stakes: ${err?.message || err}</div>`;
    if (withdrawAllBtn) withdrawAllBtn.disabled = true;
  }
}

async function renderStakeCoinOptions(address, state) {
  const selectEl = document.querySelector('#stakeCoinSelect');
  const stakeBtn = document.querySelector('#stakeNowBtn');
  const stakeAllBtn = document.querySelector('#stakeAllBtn');
  if (!selectEl) return;

  if (!address) {
    APP_STATE.stakeCoins = [];
    selectEl.innerHTML = '<option value="">Connect wallet first</option>';
    if (stakeBtn) stakeBtn.disabled = true;
    if (stakeAllBtn) stakeAllBtn.disabled = true;
    return;
  }

  selectEl.innerHTML = '<option value="">Loading XENI coins...</option>';

  try {
    const packageId = state.packageId || CHAIN_CONFIG.packageId;
    const coinType = `${packageId}::xen::XEN`;
    const coins = await rpcCall('iotax_getCoins', [address, coinType, null, 50]);
    const data = coins?.data || [];

    APP_STATE.stakeCoins = data.map((c) => ({
      id: c.coinObjectId || c.objectId || '',
      balanceRaw: BigInt(String(c.balance || '0')),
    }));

    if (!data.length) {
      selectEl.innerHTML = '<option value="">No XENI coin objects found</option>';
      if (stakeBtn) stakeBtn.disabled = true;
      if (stakeAllBtn) stakeAllBtn.disabled = true;
      return;
    }

    selectEl.innerHTML = data
      .map((c, i) => {
        const id = c.coinObjectId || c.objectId || '';
        const balRaw = String(c.balance || '0');
        const balHuman = formatUnits(balRaw, TOKEN_DECIMALS, 6);
        const short = `${id.slice(0, 8)}...${id.slice(-6)}`;
        return `<option value="${id}" ${i === 0 ? 'selected' : ''}>${short} · balance: ${balHuman} XENI</option>`;
      })
      .join('');

    if (stakeBtn) stakeBtn.disabled = false;
    if (stakeAllBtn) stakeAllBtn.disabled = APP_STATE.stakeCoins.length === 0;
  } catch (err) {
    APP_STATE.stakeCoins = [];
    selectEl.innerHTML = `<option value="">Failed to load coins: ${(err?.message || err).replace(/"/g, '&quot;')}</option>`;
    if (stakeBtn) stakeBtn.disabled = true;
    if (stakeAllBtn) stakeAllBtn.disabled = true;
  }
}

async function executeStakeTx(state, opts = {}) {
  const session = APP_STATE.walletSession;
  const statusEl = document.querySelector('#stakeTxStatus');
  const amountInput = document.querySelector('#stakeAmount');
  const termInput = document.querySelector('#stakeTermDays');
  const coinSelect = document.querySelector('#stakeCoinSelect');
  const stakeBtn = document.querySelector('#stakeNowBtn');
  const stakeAllBtn = document.querySelector('#stakeAllBtn');

  if (!session?.wallet || !session?.account) {
    if (statusEl) statusEl.textContent = 'Connect wallet first.';
    return;
  }
  if (!amountInput || !termInput || !coinSelect) return;

  const stakeAll = Boolean(opts?.stakeAll);
  const termDays = Math.floor(Number(termInput.value || 0));

  if (termDays < 1 || termDays > 1000) {
    if (statusEl) statusEl.textContent = 'Stake term must be between 1 and 1000 days.';
    return;
  }

  let coinId = '';
  let amountRaw = 0n;
  let amountHumanText = '';

  if (stakeAll) {
    const coins = (APP_STATE.stakeCoins || []).filter((c) => c.id && c.balanceRaw > 0n);
    if (!coins.length) {
      if (statusEl) statusEl.textContent = 'No stakeable XENI coin objects found.';
      return;
    }

    coinId = coins[0].id;
    amountRaw = coins.reduce((acc, c) => acc + c.balanceRaw, 0n);
    amountHumanText = formatUnits(amountRaw, TOKEN_DECIMALS, 6);

    if (amountRaw <= 0n) {
      if (statusEl) statusEl.textContent = 'No stakeable XENI balance found.';
      return;
    }
  } else {
    const amountText = String(amountInput.value || '').trim().replace(/,/g, '.');
    const parsed = parseUnits(amountText, TOKEN_DECIMALS);
    coinId = String(coinSelect.value || '').trim();

    if (!coinId) {
      if (statusEl) statusEl.textContent = 'Select a XENI coin object.';
      return;
    }
    if (!parsed || parsed <= 0n) {
      if (statusEl) statusEl.textContent = 'Enter a valid stake amount in XENI (e.g., 1.25).';
      return;
    }

    const selected = (APP_STATE.stakeCoins || []).find((c) => c.id === coinId);
    if (selected && parsed > selected.balanceRaw) {
      if (statusEl) statusEl.textContent = 'Stake amount exceeds selected coin balance.';
      return;
    }

    amountRaw = parsed;
    amountHumanText = amountText;
  }

  if (amountRaw > U64_MAX) {
    if (statusEl) statusEl.textContent = 'Stake amount is too large for u64.';
    return;
  }

  try {
    if (stakeBtn) stakeBtn.disabled = true;
    if (stakeAllBtn) stakeAllBtn.disabled = true;
    if (statusEl) statusEl.textContent = stakeAll
      ? `Preparing stake-all transaction for ${amountHumanText} XENI...`
      : `Preparing stake transaction for ${amountHumanText} XENI...`;

    const { Transaction } = await import('https://esm.sh/@iota/iota-sdk/transactions');
    const tx = new Transaction();

    if (stakeAll) {
      const mergeSources = (APP_STATE.stakeCoins || [])
        .filter((c) => c.id && c.id !== coinId && c.balanceRaw > 0n)
        .map((c) => c.id);
      if (mergeSources.length) {
        tx.mergeCoins(coinId, mergeSources);
      }
    }

    tx.moveCall({
      target: `${state.packageId || CHAIN_CONFIG.packageId}::xen::stake`,
      arguments: [
        tx.object(CHAIN_CONFIG.protocolId),
        tx.object(CHAIN_CONFIG.clockId),
        tx.object(coinId),
        tx.pure.u64(amountRaw.toString()),
        tx.pure.u64(termDays),
      ],
    });

    const signer = session.wallet.features?.['iota:signAndExecuteTransaction'];
    if (!signer?.signAndExecuteTransaction) throw new Error('Wallet does not support signAndExecuteTransaction');

    if (statusEl) statusEl.textContent = 'Awaiting wallet signature...';
    const res = await signer.signAndExecuteTransaction({
      transaction: tx,
      account: session.account,
      chain: session.chain || CHAIN_ID,
      options: { showEffects: true },
    });

    if (statusEl) {
      statusEl.textContent = `Stake submitted. Digest: ${res?.digest || 'submitted'}`;
    }

    await renderStakeCoinOptions(session.address, state);
    await renderStakeList(session.address, state);
  } catch (err) {
    if (statusEl) statusEl.textContent = `Stake failed: ${err?.message || err}`;
  } finally {
    if (stakeBtn) stakeBtn.disabled = false;
    if (stakeAllBtn) stakeAllBtn.disabled = (APP_STATE.stakeCoins || []).length === 0;
  }
}

async function executeWithdrawTx(state, receiptId, triggerBtn) {
  const session = APP_STATE.walletSession;
  const statusEl = document.querySelector('#stakeTxStatus');

  if (!session?.wallet || !session?.account) {
    if (statusEl) statusEl.textContent = 'Connect wallet first.';
    return;
  }
  if (!receiptId) {
    if (statusEl) statusEl.textContent = 'Missing stake receipt id.';
    return;
  }

  try {
    if (triggerBtn) triggerBtn.disabled = true;
    if (statusEl) statusEl.textContent = 'Preparing withdraw transaction...';

    const { Transaction } = await import('https://esm.sh/@iota/iota-sdk/transactions');
    const tx = new Transaction();

    tx.moveCall({
      target: `${state.packageId || CHAIN_CONFIG.packageId}::xen::withdraw`,
      arguments: [
        tx.object(CHAIN_CONFIG.protocolId),
        tx.object(CHAIN_CONFIG.clockId),
        tx.object(receiptId),
      ],
    });

    const signer = session.wallet.features?.['iota:signAndExecuteTransaction'];
    if (!signer?.signAndExecuteTransaction) throw new Error('Wallet does not support signAndExecuteTransaction');

    if (statusEl) statusEl.textContent = 'Awaiting wallet signature...';
    const res = await signer.signAndExecuteTransaction({
      transaction: tx,
      account: session.account,
      chain: session.chain || CHAIN_ID,
      options: { showEffects: true },
    });

    if (statusEl) {
      statusEl.textContent = `Withdraw submitted. Digest: ${res?.digest || 'submitted'}`;
    }

    await renderStakeCoinOptions(session.address, state);
    await renderStakeList(session.address, state);
  } catch (err) {
    if (statusEl) statusEl.textContent = `Withdraw failed: ${err?.message || err}`;
  } finally {
    if (triggerBtn) triggerBtn.disabled = false;
  }
}

async function executeWithdrawAllStakesTx(state) {
  const session = APP_STATE.walletSession;
  const statusEl = document.querySelector('#stakeTxStatus');
  const withdrawAllBtn = document.querySelector('#withdrawAllStakesBtn');

  if (!session?.wallet || !session?.account) {
    if (statusEl) statusEl.textContent = 'Connect wallet first.';
    return;
  }

  let receipts = APP_STATE.stakeReceipts || [];
  if (!receipts.length) {
    await renderStakeList(session.address, state);
    receipts = APP_STATE.stakeReceipts || [];
  }

  const matured = receipts.filter((r) => r.matured && r.packageMatch && r.id && r.id !== '-');
  if (!matured.length) {
    if (statusEl) statusEl.textContent = 'No matured stakes available for withdraw.';
    return;
  }

  try {
    if (withdrawAllBtn) withdrawAllBtn.disabled = true;
    if (statusEl) statusEl.textContent = `Preparing withdraw-all transaction for ${matured.length} stake(s)...`;

    const { Transaction } = await import('https://esm.sh/@iota/iota-sdk/transactions');
    const tx = new Transaction();

    for (const receipt of matured) {
      tx.moveCall({
        target: `${state.packageId || CHAIN_CONFIG.packageId}::xen::withdraw`,
        arguments: [
          tx.object(CHAIN_CONFIG.protocolId),
          tx.object(CHAIN_CONFIG.clockId),
          tx.object(receipt.id),
        ],
      });
    }

    const signer = session.wallet.features?.['iota:signAndExecuteTransaction'];
    if (!signer?.signAndExecuteTransaction) throw new Error('Wallet does not support signAndExecuteTransaction');

    if (statusEl) statusEl.textContent = 'Awaiting wallet signature...';
    const res = await signer.signAndExecuteTransaction({
      transaction: tx,
      account: session.account,
      chain: session.chain || CHAIN_ID,
      options: { showEffects: true },
    });

    if (statusEl) statusEl.textContent = `Withdraw-all submitted. Digest: ${res?.digest || 'submitted'}`;

    await renderStakeCoinOptions(session.address, state);
    await renderStakeList(session.address, state);
  } catch (err) {
    if (statusEl) statusEl.textContent = `Withdraw-all failed: ${err?.message || err}`;
  } finally {
    if (withdrawAllBtn) withdrawAllBtn.disabled = false;
  }
}

function setupStakingUi(state) {
  const refreshBtn = document.querySelector('#refreshStakeCoins');
  const stakeBtn = document.querySelector('#stakeNowBtn');
  const stakeAllBtn = document.querySelector('#stakeAllBtn');
  const withdrawAllBtn = document.querySelector('#withdrawAllStakesBtn');
  const stakeList = document.querySelector('#stakeList');

  if (refreshBtn && !refreshBtn.dataset.bound) {
    refreshBtn.dataset.bound = '1';
    refreshBtn.addEventListener('click', async () => {
      const session = APP_STATE.walletSession;
      await renderStakeCoinOptions(session?.address || null, state);
      await renderStakeList(session?.address || null, state);
    });
  }

  if (stakeBtn && !stakeBtn.dataset.bound) {
    stakeBtn.dataset.bound = '1';
    stakeBtn.addEventListener('click', async () => {
      await executeStakeTx(state);
    });
  }

  if (stakeAllBtn && !stakeAllBtn.dataset.bound) {
    stakeAllBtn.dataset.bound = '1';
    stakeAllBtn.addEventListener('click', async () => {
      await executeStakeTx(state, { stakeAll: true });
    });
  }

  if (withdrawAllBtn && !withdrawAllBtn.dataset.bound) {
    withdrawAllBtn.dataset.bound = '1';
    withdrawAllBtn.addEventListener('click', async () => {
      await executeWithdrawAllStakesTx(state);
    });
  }

  if (stakeList && !stakeList.dataset.bound) {
    stakeList.dataset.bound = '1';
    stakeList.addEventListener('click', async (e) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const btn = target.closest('.withdraw-stake-btn');
      if (!btn) return;

      const receiptId = String(btn.getAttribute('data-receipt-id') || '').trim();
      await executeWithdrawTx(state, receiptId, btn);
    });
  }
}

async function loadMintReceipts(address, state) {
  if (!address) return [];
  const packageId = state.packageId || CHAIN_CONFIG.packageId;
  const objects = await fetchOwnedObjects(address, 6);

  return objects
    .filter((o) => String(o?.data?.type || '').endsWith('::xen::MintReceipt'))
    .map((receipt) => {
      const f = receipt?.data?.content?.fields || {};
      const maturityMs = Number(f.maturity_ts_ms || 0);
      const nowMs = Date.now();
      return {
        id: f?.id?.id || receipt?.data?.objectId || '-',
        cRank: Number(f.c_rank || 0),
        termDays: Number(f.term_days || 0),
        maturityMs,
        ampAtClaim: Number(f.amp_at_claim || 0),
        matured: nowMs >= maturityMs,
        packageMatch: String(receipt?.data?.type || '').startsWith(String(packageId)),
      };
    });
}

function syncMintUiState() {
  const mintBtn = document.querySelector('#mintNowBtn');
  const claimBtn = document.querySelector('#claimMintBtn');
  const claimRow = document.querySelector('#claimActionRow');
  const statusEl = document.querySelector('#mintTxStatus');

  if (!mintBtn || !claimBtn || !claimRow || !statusEl) return;

  const session = APP_STATE.walletSession;
  const receipts = APP_STATE.activeMintReceipts || [];
  const claimable = receipts.filter((r) => r.matured && r.packageMatch && r.id && r.id !== '-');

  // Show claim-all action only when there is at least one claimable receipt.
  const showClaimAction = Boolean(session && claimable.length > 0);
  claimRow.hidden = !showClaimAction;
  claimRow.style.display = showClaimAction ? 'flex' : 'none';
  claimRow.setAttribute('aria-hidden', showClaimAction ? 'false' : 'true');

  if (!session) {
    mintBtn.disabled = true;
    mintBtn.textContent = 'Start mint (claim rank)';
    claimBtn.disabled = true;
    claimBtn.textContent = 'Claim all mint rewards';
    statusEl.textContent = '';
    return;
  }

  // Parallel mint mode: mint can always start; claim button appears for matured receipts.
  mintBtn.disabled = false;
  mintBtn.textContent = 'Start mint (claim rank)';
  claimBtn.disabled = claimable.length === 0;
  claimBtn.textContent = claimable.length > 1 ? `Claim all mint rewards (${claimable.length})` : 'Claim all mint rewards';
  statusEl.textContent = '';
}

async function executeClaimRankTx(state) {
  const session = APP_STATE.walletSession;
  const statusEl = document.querySelector('#mintTxStatus');
  const termInput = document.querySelector('#mintTermDays');
  const mintBtn = document.querySelector('#mintNowBtn');

  if (!session?.wallet || !session?.account) {
    if (statusEl) statusEl.textContent = 'Connect wallet first.';
    return;
  }
  if (!termInput) return;

  // Refresh local receipt cache before minting (parallel mints allowed by updated contract).
  try {
    const receipts = await loadMintReceipts(session.address, state);
    APP_STATE.activeMintReceipts = receipts;
    APP_STATE.activeMintReceipt = receipts[0] || null;
    syncMintUiState();
  } catch (err) {
    if (statusEl) statusEl.textContent = `Mint precheck warning: ${err?.message || err}`;
  }

  let termDays = Math.floor(Number(termInput.value || 0));
  termDays = Math.max(1, Math.min(100, termDays));
  termInput.value = String(termDays);

  try {
    if (mintBtn) mintBtn.disabled = true;
    if (statusEl) statusEl.textContent = `Preparing mint tx (term ${termDays} days)...`;

    const { Transaction } = await import('https://esm.sh/@iota/iota-sdk/transactions');
    const tx = new Transaction();

    tx.moveCall({
      target: `${state.packageId || CHAIN_CONFIG.packageId}::xen::claim_rank`,
      arguments: [
        tx.object(CHAIN_CONFIG.protocolId),
        tx.object(CHAIN_CONFIG.clockId),
        tx.pure.u64(termDays),
      ],
    });

    const signer = session.wallet.features?.['iota:signAndExecuteTransaction'];
    if (!signer?.signAndExecuteTransaction) throw new Error('Wallet does not support signAndExecuteTransaction');

    if (statusEl) statusEl.textContent = 'Awaiting wallet signature...';
    const res = await signer.signAndExecuteTransaction({
      transaction: tx,
      account: session.account,
      chain: session.chain || CHAIN_ID,
      options: { showEffects: true },
    });

    if (statusEl) statusEl.textContent = `Mint submitted. Digest: ${res?.digest || 'submitted'}`;

    await renderClaimStatus(session.address, state);
  } catch (err) {
    const msg = String(err?.message || err || 'unknown error');
    if (statusEl) {
      statusEl.textContent = msg.includes('Abort Code: 0')
        ? 'Mint failed with on-chain Abort 0. This means deployed contract still enforces one active mint per wallet. Parallel mint logic needs contract publish/upgrade.'
        : `Mint failed: ${msg}`;
    }
  } finally {
    if (mintBtn) mintBtn.disabled = false;
    syncMintUiState();
  }
}

async function executeClaimMintRewardTx(state) {
  const session = APP_STATE.walletSession;
  const statusEl = document.querySelector('#mintTxStatus');
  const claimBtn = document.querySelector('#claimMintBtn');

  if (!session?.wallet || !session?.account) {
    if (statusEl) statusEl.textContent = 'Connect wallet first.';
    return;
  }

  try {
    if (claimBtn) claimBtn.disabled = true;

    let receipts = APP_STATE.activeMintReceipts || [];
    if (!receipts.length) {
      receipts = await loadMintReceipts(session.address, state);
      APP_STATE.activeMintReceipts = receipts;
      APP_STATE.activeMintReceipt = receipts[0] || null;
    }

    const claimable = receipts.filter((r) => r.matured && r.packageMatch && r.id && r.id !== '-');
    if (!claimable.length) {
      if (statusEl) statusEl.textContent = 'No claimable mint receipts found.';
      return;
    }

    if (statusEl) statusEl.textContent = `Preparing claim-all transaction for ${claimable.length} receipt(s)...`;

    const { Transaction } = await import('https://esm.sh/@iota/iota-sdk/transactions');
    const tx = new Transaction();

    for (const receipt of claimable) {
      tx.moveCall({
        target: `${state.packageId || CHAIN_CONFIG.packageId}::xen::claim_mint_reward`,
        arguments: [
          tx.object(CHAIN_CONFIG.protocolId),
          tx.object(CHAIN_CONFIG.clockId),
          tx.object(receipt.id),
        ],
      });
    }

    const signer = session.wallet.features?.['iota:signAndExecuteTransaction'];
    if (!signer?.signAndExecuteTransaction) throw new Error('Wallet does not support signAndExecuteTransaction');

    if (statusEl) statusEl.textContent = 'Awaiting wallet signature...';
    const res = await signer.signAndExecuteTransaction({
      transaction: tx,
      account: session.account,
      chain: session.chain || CHAIN_ID,
      options: { showEffects: true },
    });

    if (statusEl) statusEl.textContent = `Claim-all submitted. Digest: ${res?.digest || 'submitted'}`;

    await renderClaimStatus(session.address, state);
    await renderStakeCoinOptions(session.address, state);
  } catch (err) {
    if (statusEl) statusEl.textContent = `Claim failed: ${err?.message || err}`;
  } finally {
    if (claimBtn) claimBtn.disabled = false;
    syncMintUiState();
  }
}

function setupMintUi(state) {
  const mintBtn = document.querySelector('#mintNowBtn');
  const claimBtn = document.querySelector('#claimMintBtn');
  const termInput = document.querySelector('#mintTermDays');

  if (termInput && !termInput.dataset.inited) {
    termInput.dataset.inited = '1';
    const suggested = Math.min(100, Math.max(1, Math.floor(Number(state?.maxTerm || 30))));
    termInput.value = String(suggested);
  }

  if (mintBtn && !mintBtn.dataset.bound) {
    mintBtn.dataset.bound = '1';
    mintBtn.addEventListener('click', async () => {
      await executeClaimRankTx(state);
    });
  }

  if (claimBtn && !claimBtn.dataset.bound) {
    claimBtn.dataset.bound = '1';
    claimBtn.addEventListener('click', async () => {
      await executeClaimMintRewardTx(state);
    });
  }

  syncMintUiState();
}

async function renderClaimStatus(address, state) {
  const hintEl = document.querySelector('#claimsHint');
  const pendingEl = document.querySelector('#pendingClaims');
  const claimableEl = document.querySelector('#claimableClaims');
  if (!hintEl || !pendingEl || !claimableEl) return;

  if (!address) {
    APP_STATE.activeMintReceipt = null;
    APP_STATE.activeMintReceipts = [];
    hintEl.textContent = 'Connect wallet to load your mint receipt status.';
    pendingEl.textContent = '-';
    claimableEl.textContent = '-';
    syncMintUiState();
    return;
  }

  hintEl.textContent = `Loading claim status for ${address}...`;

  try {
    const receipts = await loadMintReceipts(address, state);
    APP_STATE.activeMintReceipts = receipts;
    APP_STATE.activeMintReceipt = receipts[0] || null;

    if (!receipts.length) {
      hintEl.textContent = 'No active mint receipt found for this wallet.';
      pendingEl.textContent = 'None';
      claimableEl.textContent = 'None';
      syncMintUiState();
      return;
    }

    const pending = receipts.filter((r) => !r.matured);
    const claimable = receipts.filter((r) => r.matured);

    if (pending.length) {
      const previewN = 2;
      const lines = pending
        .slice(0, previewN)
        .map((r) => {
          const remainingDays = Math.max(0, Math.ceil((r.maturityMs - Date.now()) / DAY_MS));
          return `cRank ${fmt(r.cRank)} · term ${fmt(r.termDays)}d · matures in ${fmt(remainingDays)}d`;
        })
        .join('<br/>');
      const more = pending.length > previewN ? `<br/><span class="claim-more">+${fmt(pending.length - previewN)} more</span>` : '';
      pendingEl.innerHTML = `<div class="claim-warn"><b>${fmt(pending.length)} pending</b></div>${lines}${more}`;
    } else {
      pendingEl.textContent = 'None';
    }

    if (claimable.length) {
      const previewN = 2;
      const lines = claimable
        .slice(0, previewN)
        .map((r) => {
          const daysLate = Math.max(0, Math.floor((Date.now() - r.maturityMs) / DAY_MS));
          const penalty = latePenaltyPct(daysLate);
          return `cRank ${fmt(r.cRank)} · term ${fmt(r.termDays)}d · late ${fmt(daysLate)}d · penalty ${penalty}%`;
        })
        .join('<br/>');
      const more = claimable.length > previewN ? `<br/><span class="claim-more">+${fmt(claimable.length - previewN)} more</span>` : '';
      claimableEl.innerHTML = `<div class="claim-ok"><b>${fmt(claimable.length)} claimable</b></div>${lines}${more}`;
    } else {
      claimableEl.textContent = 'None yet';
    }

    const pkgMismatches = receipts.filter((r) => !r.packageMatch).length;
    hintEl.textContent = `Found ${fmt(receipts.length)} mint receipt(s): ${fmt(pending.length)} pending, ${fmt(claimable.length)} claimable.`;
    if (pkgMismatches > 0) {
      hintEl.textContent += ` ${fmt(pkgMismatches)} receipt(s) are from a different package id.`;
    }

    syncMintUiState();
  } catch (err) {
    APP_STATE.activeMintReceipt = null;
    APP_STATE.activeMintReceipts = [];
    console.error('Claim status read failed', err);
    hintEl.textContent = 'Claim status read failed. Please reconnect wallet and try again.';
    pendingEl.textContent = 'Unavailable';
    claimableEl.textContent = 'Unavailable';
    syncMintUiState();
  }
}

async function setupWalletConnection(onSessionChange) {
  const statusEl = document.querySelector('#walletStatus');
  const connectBtn = document.querySelector('#connectWalletBtn');
  const disconnectBtn = document.querySelector('#disconnectWalletBtn');

  if (!statusEl || !connectBtn || !disconnectBtn) return;

  const emitSession = (session) => {
    APP_STATE.walletSession = session || null;
    if (typeof onSessionChange === 'function') onSessionChange(APP_STATE.walletSession);
  };

  const setStatus = (t) => (statusEl.textContent = t);
  const shortAddress = (addr) => {
    const a = String(addr || '');
    if (a.length < 12) return a;
    return `${a.slice(0, 6)}...${a.slice(-4)}`;
  };
  const safeGet = (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  };
  const safeSet = (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  };
  const safeDel = (k) => {
    try {
      localStorage.removeItem(k);
    } catch {}
  };

  let currentWallet = null;
  let wallets = [];

  let getWallets;
  try {
    ({ getWallets } = await import('https://esm.sh/@wallet-standard/app@1.1.0'));
  } catch {
    setStatus('Wallet module failed to load. Refresh and try again.');
    return;
  }

  const api = getWallets();

  const activateSession = (target, acc, { restored = false } = {}) => {
    currentWallet = target;
    connectBtn.textContent = shortAddress(acc.address);
    disconnectBtn.disabled = false;
    setStatus(restored ? `Reconnected: ${target.name}` : `Connected: ${target.name}`);

    const session = {
      wallet: target,
      account: acc,
      address: acc.address,
      chain: (Array.from(acc.chains || []).find((c) => String(c).startsWith('iota:')) || CHAIN_ID),
    };
    emitSession(session);
  };

  const refresh = () => {
    wallets = (api.get() || []).filter((w) => Array.from(w.chains || []).some((c) => String(c).startsWith('iota:')));

    if (!wallets.length) {
      connectBtn.disabled = false;
      connectBtn.textContent = 'Get IOTA Wallet';
      disconnectBtn.disabled = true;
      setStatus('No compatible IOTA wallet found. Click "Get IOTA Wallet" to install the extension.');
      emitSession(null);
      return;
    }

    // Auto-restore on refresh when wallet exposes already-authorized accounts.
    if (!currentWallet && safeGet(WALLET_AUTO_KEY) === '1') {
      const preferredName = safeGet(WALLET_PREF_KEY);
      const target = wallets.find((w) => w.name === preferredName) || wallets[0];
      const acc = target?.accounts?.[0];
      if (target && acc) {
        activateSession(target, acc, { restored: true });
        return;
      }
    }

    connectBtn.disabled = false;
    disconnectBtn.disabled = !currentWallet;
    if (!currentWallet) {
      connectBtn.textContent = 'Connect';
      const primary = wallets[0]?.name || 'wallet';
      const more = wallets.length > 1 ? ` (+${wallets.length - 1} more detected)` : '';
      setStatus(`Wallet detected: ${primary}${more}. Click Connect.`);
    }
  };

  connectBtn.onclick = async () => {
    const target = wallets[0];
    if (!target) {
      window.open(WALLET_DOWNLOAD_URL, '_blank', 'noopener,noreferrer');
      setStatus('Opened wallet download page. Install the extension, then refresh.');
      return;
    }

    try {
      const connectFeature = target.features?.['standard:connect'];
      if (!connectFeature?.connect) throw new Error('Wallet does not support connect');
      const res = await connectFeature.connect();
      const acc = res?.accounts?.[0] || target.accounts?.[0];
      if (!acc) throw new Error('No account returned');

      safeSet(WALLET_AUTO_KEY, '1');
      safeSet(WALLET_PREF_KEY, target.name || '');
      activateSession(target, acc);
    } catch (e) {
      setStatus(`Connect failed: ${e?.message || e}`);
    }
  };

  disconnectBtn.onclick = async () => {
    try {
      const f = currentWallet?.features?.['standard:disconnect'];
      if (f?.disconnect) await f.disconnect();
    } finally {
      currentWallet = null;
      connectBtn.textContent = 'Connect';
      disconnectBtn.disabled = true;
      emitSession(null);
      safeDel(WALLET_AUTO_KEY);
      safeDel(WALLET_PREF_KEY);
      refresh();
      if (!wallets.length) setStatus('Disconnected.');
    }
  };

  api.on('register', refresh);
  api.on('unregister', refresh);
  refresh();
}

async function main() {
  let state;
  try {
    state = await fetchOnchainState();
    renderSnapshot(state, 'ON-CHAIN');
  } catch {
    const res = await fetch('./data/latest.json');
    const data = await res.json();
    const tl = data?.defaultScenario?.timelineSample || [];
    const latest = tl[tl.length - 1] || {};
    const rank = Number(data?.defaultScenario?.finalGlobalRank || 0);

    state = {
      source: 'simulation',
      globalRank: rank,
      maxTerm: freeMintTermLimitForRank(rank),
      amp: Number(latest.amp || 0),
      apyBps: Number(latest.apyBps || 0),
    };
    renderSnapshot(state, 'SIMULATION FALLBACK');
  }

  APP_STATE.protocol = state;

  renderFeeSimulator(state);
  renderStakingPreview(state);
  setupCursorFx();
  setupMintUi(state);
  setupStakingUi(state);

  await renderClaimStatus(null, state);
  await renderStakeCoinOptions(null, state);
  await renderStakeList(null, state);

  await setupWalletConnection((session) => {
    const address = session?.address || null;
    renderClaimStatus(address, state);
    renderStakeCoinOptions(address, state);
    renderStakeList(address, state);
  });

  setText('#stamp', `Updated: ${new Date().toLocaleString()}`);
}

main().catch((err) => {
  console.error(err);
  setText('#walletStatus', `Error: ${err?.message || err}`);
});
