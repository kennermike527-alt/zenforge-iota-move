import { initCursorAnimation } from './cursor-animation.js';

const fmt = (n) => new Intl.NumberFormat().format(Number(n || 0));

const CHAIN_CONFIG = {
  rpcUrl: window.ZENFORGE_RPC_URL || 'https://api.testnet.iota.cafe',
  protocolId:
    window.ZENFORGE_PROTOCOL_ID ||
    '0x3fb22d58d2ce2f6c603a64428d37bd164ecad60564a9e823de8c393b5a428678',
  packageId:
    window.ZENFORGE_PACKAGE_ID ||
    '0x4a146c82ea75b2894da92d52b40d9406bfab7ddc9abf38ff97fd3013190548fd',
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
const IOTA_MIST = 1_000_000_000n;
const CLAIM_FEE_MIN_MIST = BigInt(Math.round(BASE_MIN_FEE * 1_000_000_000));
const CLAIM_FEE_MAX_MIST = BigInt(Math.round(BASE_MAX_FEE * 1_000_000_000));
const WALLET_DOWNLOAD_URL =
  'https://chromewebstore.google.com/detail/iota-wallet/iidjkmdceolghepehaaddojmnjnkkija';
const WALLET_AUTO_KEY = 'xenforgeWalletAutoconnect';
const WALLET_PREF_KEY = 'xenforgeWalletPreferredName';
const WALLET_ADDR_KEY = 'xenforgeWalletAddress';
const APP_STATE = {
  protocol: null,
  walletSession: null,
  activeMintReceipt: null,
  activeMintReceipts: [],
  stakeCoins: [],
  stakeReceipts: [],
  claimCountdownTimer: null,
  claimCountdownRefreshPending: false,
  pendingViewLimit: 25,
  protocolPollTimer: null,
};

function txErrorMessage(err) {
  const raw = String(err?.message || err || 'Unknown error').trim();
  return raw.split('\n')[0].slice(0, 360);
}

function showTxPopup(kind, title, message, digest = '') {
  if (typeof document === 'undefined') return;

  let root = document.querySelector('#txToastRoot');
  if (!root) {
    root = document.createElement('div');
    root.id = 'txToastRoot';
    root.className = 'tx-toast-root';
    document.body.appendChild(root);
  }

  const toast = document.createElement('div');
  toast.className = `tx-toast ${kind || 'info'}`;
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');

  const titleEl = document.createElement('div');
  titleEl.className = 'tx-toast-title';
  titleEl.textContent = title;
  toast.appendChild(titleEl);

  if (message) {
    const msgEl = document.createElement('div');
    msgEl.className = 'tx-toast-message';
    msgEl.textContent = message;
    toast.appendChild(msgEl);
  }

  if (digest) {
    const digestEl = document.createElement('div');
    digestEl.className = 'tx-toast-digest';
    digestEl.textContent = `Digest: ${digest}`;
    toast.appendChild(digestEl);
  }

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'tx-toast-close';
  closeBtn.textContent = '×';

  const remove = () => {
    if (toast.parentElement) toast.parentElement.removeChild(toast);
  };

  closeBtn.addEventListener('click', remove);
  toast.appendChild(closeBtn);

  root.prepend(toast);

  while (root.children.length > 4) {
    root.removeChild(root.lastElementChild);
  }

  window.setTimeout(remove, 8000);
}

function ensureNetworkForTx(session, statusEl) {
  const accountChains = Array.from(session?.account?.chains || []);
  if (accountChains.length && !accountChains.includes(CHAIN_ID)) {
    const msg = `Wallet/account network mismatch. Switch to ${CHAIN_CONFIG.networkLabel} (${CHAIN_ID}) and retry.`;
    if (statusEl) statusEl.textContent = msg;
    showTxPopup('error', 'Wrong network', msg);
    return false;
  }
  return true;
}

async function enforceCurrentPackageStakeCoins(coinIds, state) {
  const packageId = state?.packageId || CHAIN_CONFIG.packageId;
  const expectedType = `${packageId}::xen::XEN`;
  const ids = Array.from(new Set((coinIds || []).filter(Boolean)));

  const invalid = [];
  for (const id of ids) {
    try {
      const obj = await rpcCall('iota_getObject', [id, { showType: true }]);
      const t = structType(obj);
      if (t !== expectedType) invalid.push({ id, type: t || 'unknown' });
    } catch {
      invalid.push({ id, type: 'unreadable' });
    }
  }

  return {
    ok: invalid.length === 0,
    invalid,
    expectedType,
  };
}

function delayMs(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function refreshClaimStatusWithRetry(address, state, { expectedMinCount = 0, retries = 12, delay = 1500, statusEl } = {}) {
  for (let i = 0; i < retries; i += 1) {
    await renderClaimStatus(address, state);
    const seen = (APP_STATE.activeMintReceipts || []).length;
    if (seen >= expectedMinCount) return true;

    if (statusEl) {
      statusEl.textContent = `Mint confirmed. Syncing receipts (${i + 1}/${retries})...`;
    }
    await delayMs(delay);
  }

  return false;
}

function formatClockHms(totalSeconds) {
  const safe = Math.max(0, Math.floor(Number(totalSeconds || 0)));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function stopClaimCountdownTicker() {
  if (APP_STATE.claimCountdownTimer) {
    window.clearInterval(APP_STATE.claimCountdownTimer);
    APP_STATE.claimCountdownTimer = null;
  }
}

function updateClaimCountdowns() {
  const nodes = Array.from(document.querySelectorAll('[data-live-countdown="1"]'));
  if (!nodes.length) {
    stopClaimCountdownTicker();
    return;
  }

  const now = Date.now();
  let crossedMaturity = false;

  for (const node of nodes) {
    const maturityMs = Number(node.getAttribute('data-maturity-ms') || '0');
    const remainingMs = maturityMs - now;

    if (remainingMs <= 0) {
      node.textContent = '00:00:00';
      crossedMaturity = true;
      continue;
    }

    node.textContent = formatClockHms(remainingMs / 1000);
  }

  if (crossedMaturity && !APP_STATE.claimCountdownRefreshPending) {
    const address = APP_STATE.walletSession?.address;
    const state = APP_STATE.protocol;
    if (address && state) {
      APP_STATE.claimCountdownRefreshPending = true;
      window.setTimeout(async () => {
        try {
          await renderClaimStatus(address, state);
        } finally {
          APP_STATE.claimCountdownRefreshPending = false;
        }
      }, 900);
    }
  }
}

function ensureClaimCountdownTicker() {
  updateClaimCountdowns();

  const hasCountdownNodes = Boolean(document.querySelector('[data-live-countdown="1"]'));
  if (!hasCountdownNodes) return;

  if (APP_STATE.claimCountdownTimer) return;
  APP_STATE.claimCountdownTimer = window.setInterval(updateClaimCountdowns, 1000);
}

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

function claimRankFeeMist(termDays) {
  const d = BigInt(clamp(Math.floor(Number(termDays || 1)), 1, 365));
  return CLAIM_FEE_MIN_MIST + ((CLAIM_FEE_MAX_MIST - CLAIM_FEE_MIN_MIST) * (365n - d)) / 364n;
}

function claimRankFeeIota(termDays) {
  return Number(claimRankFeeMist(termDays)) / 1_000_000_000;
}

function hardLockedFeeForTerm(termDays) {
  const day = clamp(Math.floor(Number(termDays || 1)), 1, 365);
  const fee = claimRankFeeIota(day);
  return {
    day,
    fee,
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
  setText('#metricApy', `${(Number(state.apyBps || 0) / 100).toFixed(2)}%`);
  setText('#selectableTermHint', `Max mint term right now: ${fmt(state.maxTerm)} days (protocol-controlled; increases as global rank grows).`);

  const isLive = !sourceLabel.includes('FALLBACK');

  const fetchBar = document.querySelector('#liveFetchBar');
  const fetchText = document.querySelector('#liveFetchText');
  if (fetchBar && fetchText) {
    fetchBar.classList.remove('checking', 'live', 'fallback');
    fetchBar.classList.add(isLive ? 'live' : 'fallback');
    fetchText.textContent = isLive
      ? 'Metrics fetched live'
      : 'Live fetch unavailable — showing fallback data';
  }
}

async function refreshProtocolState(state, { markFallbackOnError = false } = {}) {
  try {
    const live = await fetchOnchainState();
    Object.assign(state, live);
    APP_STATE.protocol = state;
    renderSnapshot(state, 'ON-CHAIN');
    renderFeeSimulator(state);
    setText('#stamp', `Updated: ${new Date().toLocaleString()}`);
    return true;
  } catch (err) {
    if (markFallbackOnError) {
      renderSnapshot(state, 'SIMULATION FALLBACK');
    }
    return false;
  }
}

function renderFeeSimulator(state) {
  const rankInput = document.querySelector('#simGlobalRank');
  const termInput = document.querySelector('#simTermDays');
  const ampInput = document.querySelector('#simAmp');

  const output = document.querySelector('#feeOutput');
  const formulaOutput = document.querySelector('#feeFormulaOutput');
  const feeNote = document.querySelector('#feeNote');
  const simStateNote = document.querySelector('#simStateNote');

  if (!rankInput || !termInput || !ampInput || !output || !formulaOutput) return;

  const lockedAmp = Math.max(1, Math.floor(Number(state.amp || 3000)));
  const startRank = Math.max(1, Math.floor(Number(state.globalRank || 1)));

  rankInput.value = String(startRank);
  rankInput.readOnly = true;

  ampInput.value = String(lockedAmp);
  ampInput.readOnly = true;

  const termFromInput = Math.floor(Number(termInput.value || 0));
  const defaultTerm = Math.min(100, Math.max(1, Math.floor(Number(state.maxTerm || 100))));
  termInput.value = String(termFromInput >= 1 ? Math.min(100, termFromInput) : defaultTerm);

  const update = () => {
    const rank = startRank;
    rankInput.value = String(rank);

    let termDays = Math.max(1, Math.floor(Number(termInput.value || 30)));
    termDays = Math.min(100, termDays);
    termInput.value = String(termDays);

    ampInput.value = String(lockedAmp);

    const impliedMaxTerm = freeMintTermLimitForRank(rank);
    const feeModel = hardLockedFeeForTerm(termDays);

    output.innerHTML = [
      `<b>Selected term:</b> ${termDays} days`,
      `<b>Hard-locked fee charged:</b> ${feeModel.fee.toFixed(6)} IOTA`,
      `<b>Current simulator state:</b> rank ${fmt(rank)} (live), AMP ${fmt(lockedAmp)} (locked)`,
    ].join('<br/>');

    formulaOutput.innerHTML = [
      '<b>Fee formula (hard-locked policy model):</b>',
      `<code>baseFee(day) = ${BASE_MIN_FEE.toFixed(6)} + ((${BASE_MAX_FEE.toFixed(6)} - ${BASE_MIN_FEE.toFixed(6)}) * (365 - day)) / 364</code>`,
      '<code>fee = baseFee(day)</code>',
      `<b>Current inputs:</b> globalRank=${fmt(rank)}, day=${termDays}`,
      `<b>Computed fee:</b> ${feeModel.fee.toFixed(6)} IOTA`,
    ].join('<br/>');

    if (simStateNote) {
      simStateNote.textContent = `Formula-implied max term from rank is ${fmt(impliedMaxTerm)} days. Global rank is live/read-only.`;
    }

    if (feeNote) feeNote.textContent = 'Fee shown here is hard-locked by selected term and enforced on-chain in claim_rank.';
  };

  rankInput.oninput = update;
  rankInput.onchange = update;
  termInput.oninput = update;
  termInput.onchange = update;

  update();
}

function renderStakingPreview(state) {
  const apyBpsEl = document.querySelector('#stakeApyBps');
  const apyPctEl = document.querySelector('#stakeApyPct');
  const amountInput = document.querySelector('#stakeAmount');
  const termInput = document.querySelector('#stakeTermDays');
  const output = document.querySelector('#stakingOutput');
  const note = document.querySelector('#stakingNote');

  if (!apyBpsEl || !amountInput || !termInput || !output) return;

  const apyBps = Math.max(0, Math.floor(Number(state.apyBps || 0)));
  const rate = apyBps / 10_000;
  apyBpsEl.textContent = `${(rate * 100).toFixed(2)}% APY`;
  if (apyPctEl) apyPctEl.textContent = 'Fixed at stake start';

  const update = () => {
    const principal = Math.max(0, Number(String(amountInput.value || '0').replace(/,/g, '.')) || 0);
    const termDays = Math.max(1, Math.min(1000, Math.floor(Number(termInput.value || 365))));
    termInput.value = String(termDays);

    const rate = apyBps / 10_000;
    const reward = principal * rate * (termDays / 365);
    const total = principal + reward;
    const rawApprox = parseUnits(String(principal), TOKEN_DECIMALS);

    output.innerHTML = [
      `<b>Staked principal:</b> ${fmtDec(principal)} XEN`,
      `<b>APY:</b> ${(rate * 100).toFixed(2)}%`,
      `<b>Term:</b> ${fmt(termDays)} days`,
      `<b>Estimated reward:</b> ${fmtDec(reward)} XEN`,
      `<b>Estimated total at maturity:</b> ${fmtDec(total)} XEN`,
      `<b>Raw amount used on-chain:</b> ${rawApprox ? fmt(rawApprox.toString()) : '-'}`,
    ].join('<br/>');

    if (note) {
      note.textContent = 'Preview uses a simple linear estimate for readability. Stake input is in human XEN, converted to 18-decimal raw units for transaction build.';
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
  initCursorAnimation({ toggleSelector: '#cursorToggle' });
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
            <b>Principal:</b> ${fmtDec(s.principal)} XEN<br/>
            <b>Principal (raw):</b> ${fmt(s.principalRaw.toString())}<br/>
            <b>Term:</b> ${fmt(s.termDays)} days<br/>
            <b>APY:</b> ${(Number(s.apyBps || 0) / 100).toFixed(2)}%<br/>
            <b>Estimated reward:</b> ${fmtDec(s.estReward)} XEN<br/>
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

  selectEl.innerHTML = '<option value="">Loading XEN coins...</option>';

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
      selectEl.innerHTML = '<option value="">No XEN coin objects found</option>';
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
        return `<option value="${id}" ${i === 0 ? 'selected' : ''}>${short} · balance: ${balHuman} XEN</option>`;
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
  if (!ensureNetworkForTx(session, statusEl)) return;
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
  let guardCoinIds = [];

  if (stakeAll) {
    const coins = (APP_STATE.stakeCoins || []).filter((c) => c.id && c.balanceRaw > 0n);
    if (!coins.length) {
      if (statusEl) statusEl.textContent = 'No stakeable XEN coin objects found.';
      return;
    }

    coinId = coins[0].id;
    guardCoinIds = coins.map((c) => c.id);
    amountRaw = coins.reduce((acc, c) => acc + c.balanceRaw, 0n);
    amountHumanText = formatUnits(amountRaw, TOKEN_DECIMALS, 6);

    if (amountRaw <= 0n) {
      if (statusEl) statusEl.textContent = 'No stakeable XEN balance found.';
      return;
    }
  } else {
    const amountText = String(amountInput.value || '').trim().replace(/,/g, '.');
    const parsed = parseUnits(amountText, TOKEN_DECIMALS);
    coinId = String(coinSelect.value || '').trim();

    if (!coinId) {
      if (statusEl) statusEl.textContent = 'Select a XEN coin object.';
      return;
    }
    if (!parsed || parsed <= 0n) {
      if (statusEl) statusEl.textContent = 'Enter a valid stake amount in XEN (e.g., 1.25).';
      return;
    }

    const selected = (APP_STATE.stakeCoins || []).find((c) => c.id === coinId);
    if (selected && parsed > selected.balanceRaw) {
      if (statusEl) statusEl.textContent = 'Stake amount exceeds selected coin balance.';
      return;
    }

    amountRaw = parsed;
    amountHumanText = amountText;
    guardCoinIds = [coinId];
  }

  if (amountRaw > U64_MAX) {
    if (statusEl) statusEl.textContent = 'Stake amount is too large for u64.';
    return;
  }

  const guard = await enforceCurrentPackageStakeCoins(guardCoinIds, state);
  if (!guard.ok) {
    const bad = guard.invalid[0];
    const msg = `Blocked: only current-package XEN can be staked. Rejected coin ${bad?.id || ''} (${bad?.type || 'unknown type'}).`;
    if (statusEl) statusEl.textContent = msg;
    showTxPopup('error', 'Stake blocked', msg);
    return;
  }

  try {
    if (stakeBtn) stakeBtn.disabled = true;
    if (stakeAllBtn) stakeAllBtn.disabled = true;
    if (statusEl) statusEl.textContent = stakeAll
      ? `Preparing stake-all transaction for ${amountHumanText} XEN...`
      : `Preparing stake transaction for ${amountHumanText} XEN...`;

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
      chain: CHAIN_ID,
      options: { showEffects: true },
    });

    if (statusEl) {
      statusEl.textContent = `Stake submitted. Digest: ${res?.digest || 'submitted'}`;
    }
    showTxPopup('success', 'Stake submitted', `Stake ${stakeAll ? 'all' : 'amount'} confirmed by wallet.`, res?.digest || '');

    await renderStakeCoinOptions(session.address, state);
    await renderStakeList(session.address, state);
  } catch (err) {
    const msg = txErrorMessage(err);
    if (statusEl) statusEl.textContent = `Stake failed: ${msg}`;
    showTxPopup('error', 'Stake failed', msg);
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
  if (!ensureNetworkForTx(session, statusEl)) return;
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
      chain: CHAIN_ID,
      options: { showEffects: true },
    });

    if (statusEl) {
      statusEl.textContent = `Withdraw submitted. Digest: ${res?.digest || 'submitted'}`;
    }
    showTxPopup('success', 'Withdraw submitted', 'Stake withdraw transaction sent.', res?.digest || '');

    await renderStakeCoinOptions(session.address, state);
    await renderStakeList(session.address, state);
  } catch (err) {
    const msg = txErrorMessage(err);
    if (statusEl) statusEl.textContent = `Withdraw failed: ${msg}`;
    showTxPopup('error', 'Withdraw failed', msg);
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
  if (!ensureNetworkForTx(session, statusEl)) return;

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
      chain: CHAIN_ID,
      options: { showEffects: true },
    });

    if (statusEl) statusEl.textContent = `Withdraw-all submitted. Digest: ${res?.digest || 'submitted'}`;
    showTxPopup('success', 'Withdraw-all submitted', `Sent withdraw-all for ${matured.length} matured stake(s).`, res?.digest || '');

    await renderStakeCoinOptions(session.address, state);
    await renderStakeList(session.address, state);
  } catch (err) {
    const msg = txErrorMessage(err);
    if (statusEl) statusEl.textContent = `Withdraw-all failed: ${msg}`;
    showTxPopup('error', 'Withdraw-all failed', msg);
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
    mintBtn.textContent = 'Start mint';
    claimBtn.disabled = true;
    claimBtn.textContent = 'Claim matured mints';
    statusEl.textContent = '';
    return;
  }

  // Parallel mint mode: mint can always start; claim button appears for matured receipts.
  mintBtn.disabled = false;
  mintBtn.textContent = 'Start mint';
  claimBtn.disabled = claimable.length === 0;
  claimBtn.textContent = claimable.length > 1 ? `Claim matured mints (${claimable.length})` : 'Claim matured mints';
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
  if (!ensureNetworkForTx(session, statusEl)) return;
  if (!termInput) return;

  let receiptsBefore = APP_STATE.activeMintReceipts?.length || 0;

  // Refresh local receipt cache before minting (parallel mints allowed by updated contract).
  try {
    const receipts = await loadMintReceipts(session.address, state);
    APP_STATE.activeMintReceipts = receipts;
    APP_STATE.activeMintReceipt = receipts[0] || null;
    receiptsBefore = receipts.length;
    syncMintUiState();
  } catch (err) {
    if (statusEl) statusEl.textContent = `Mint precheck warning: ${err?.message || err}`;
  }

  let termDays = Math.floor(Number(termInput.value || 0));
  const maxTermAllowed = Math.max(1, Math.floor(Number(state?.maxTerm || 100)));
  termDays = Math.max(1, Math.min(maxTermAllowed, termDays));
  termInput.value = String(termDays);

  try {
    if (mintBtn) mintBtn.disabled = true;

    const feeMist = claimRankFeeMist(termDays);
    const feeIota = Number(feeMist) / 1_000_000_000;
    if (statusEl) statusEl.textContent = `Preparing mint tx (term ${termDays} days, fee ${feeIota.toFixed(6)} IOTA)...`;

    const { Transaction } = await import('https://esm.sh/@iota/iota-sdk/transactions');
    const tx = new Transaction();

    const feeCoin = tx.splitCoins(tx.gas, [tx.pure.u64(Number(feeMist))]);

    tx.moveCall({
      target: `${state.packageId || CHAIN_CONFIG.packageId}::xen::claim_rank`,
      arguments: [
        tx.object(CHAIN_CONFIG.protocolId),
        tx.object(CHAIN_CONFIG.clockId),
        feeCoin,
        tx.pure.u64(termDays),
      ],
    });

    const signer = session.wallet.features?.['iota:signAndExecuteTransaction'];
    if (!signer?.signAndExecuteTransaction) throw new Error('Wallet does not support signAndExecuteTransaction');

    if (statusEl) statusEl.textContent = 'Awaiting wallet signature...';
    const res = await signer.signAndExecuteTransaction({
      transaction: tx,
      account: session.account,
      chain: CHAIN_ID,
      options: { showEffects: true },
    });

    if (statusEl) statusEl.textContent = `Mint submitted. Digest: ${res?.digest || 'submitted'}`;
    showTxPopup('success', 'Mint submitted', `Mint rank tx sent (term ${termDays} days, fee ${feeIota.toFixed(6)} IOTA).`, res?.digest || '');

    await refreshProtocolState(state);

    const synced = await refreshClaimStatusWithRetry(session.address, state, {
      expectedMinCount: receiptsBefore + 1,
      retries: 14,
      delay: 1400,
      statusEl,
    });

    if (statusEl) {
      statusEl.textContent = synced
        ? 'Mint receipt synced. Pending list updated.'
        : 'Mint submitted. Receipt indexing is still catching up; list may update in a few seconds.';
    }
  } catch (err) {
    const msg = txErrorMessage(err);
    const pretty = msg.includes('Abort Code: 0')
      ? 'Mint failed with on-chain Abort 0. Deployed contract is still old-chain/single-active-mint.'
      : `Mint failed: ${msg}`;
    if (statusEl) {
      statusEl.textContent = pretty;
    }
    showTxPopup('error', 'Mint failed', pretty);
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
  if (!ensureNetworkForTx(session, statusEl)) return;

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

    if (statusEl) statusEl.textContent = `Preparing claim transaction for ${claimable.length} matured receipt(s)...`;

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
      chain: CHAIN_ID,
      options: { showEffects: true },
    });

    if (statusEl) statusEl.textContent = `Claim submitted. Digest: ${res?.digest || 'submitted'}`;
    showTxPopup('success', 'Claim submitted', `Claim tx sent for ${claimable.length} matured receipt(s).`, res?.digest || '');

    await renderClaimStatus(session.address, state);
    await renderStakeCoinOptions(session.address, state);
  } catch (err) {
    const msg = txErrorMessage(err);
    if (statusEl) statusEl.textContent = `Claim failed: ${msg}`;
    showTxPopup('error', 'Claim failed', msg);
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
    const maxTermAllowed = Math.max(1, Math.floor(Number(state?.maxTerm || 100)));
    termInput.max = String(maxTermAllowed);
    const suggested = Math.min(maxTermAllowed, Math.max(1, Math.floor(Number(termInput.value || 30))));
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
    APP_STATE.pendingViewLimit = 25;
    stopClaimCountdownTicker();
    hintEl.textContent = 'Connect wallet to load pending and claimable receipts. Read-only mode still shows protocol parameters above.';
    pendingEl.textContent = '-';
    claimableEl.textContent = '-';
    syncMintUiState();
    if (APP_STATE.protocol) renderFeeSimulator(APP_STATE.protocol);
    return;
  }

  hintEl.textContent = `Loading claim status for ${address}...`;

  try {
    const receipts = await loadMintReceipts(address, state);
    APP_STATE.activeMintReceipts = receipts;
    APP_STATE.activeMintReceipt = receipts[0] || null;

    if (!receipts.length) {
      APP_STATE.pendingViewLimit = 25;
      stopClaimCountdownTicker();
      hintEl.textContent = 'No active mint receipt found for this wallet.';
      pendingEl.textContent = 'None';
      claimableEl.textContent = 'None';
      syncMintUiState();
      renderFeeSimulator(state);
      return;
    }

    const pending = receipts.filter((r) => !r.matured);
    const claimable = receipts.filter((r) => r.matured);

    const pendingCurrent = pending.filter((r) => r.packageMatch);
    const pendingLegacy = pending.filter((r) => !r.packageMatch);
    const claimableCurrent = claimable.filter((r) => r.packageMatch);
    const claimableLegacy = claimable.filter((r) => !r.packageMatch);

    const renderClaimableChunk = (list, title, toneClass) => {
      if (!list.length) return '';
      const previewN = 2;
      const lines = list
        .slice(0, previewN)
        .map((r) => {
          const daysLate = Math.max(0, Math.floor((Date.now() - r.maturityMs) / DAY_MS));
          const penalty = latePenaltyPct(daysLate);
          return `cRank ${fmt(r.cRank)} · term ${fmt(r.termDays)}d · late ${fmt(daysLate)}d · penalty ${penalty}%`;
        })
        .join('<br/>');
      const more = list.length > previewN ? `<br/><span class="claim-more">+${fmt(list.length - previewN)} more</span>` : '';
      return `<div class="${toneClass}"><b>${fmt(list.length)} ${title}</b></div>${lines}${more}`;
    };

    if (pending.length) {
      const pendingSorted = [...pending].sort((a, b) => a.maturityMs - b.maturityMs);
      const under24hCount = pendingSorted.filter((r) => Math.max(0, r.maturityMs - Date.now()) < DAY_MS).length;

      const viewLimit = Math.max(25, Math.floor(Number(APP_STATE.pendingViewLimit || 25)));
      const visible = pendingSorted.slice(0, viewLimit);
      const rows = visible
        .map((r) => {
          const remainingMs = Math.max(0, r.maturityMs - Date.now());
          const eta = remainingMs < DAY_MS
            ? `in <span class="claim-live" data-live-countdown="1" data-maturity-ms="${r.maturityMs}">${formatClockHms(remainingMs / 1000)}</span>`
            : `in ${fmt(Math.max(1, Math.ceil(remainingMs / DAY_MS)))}d`;

          const packageTag = r.packageMatch
            ? ''
            : '<span class="claim-tag legacy">legacy</span>';

          return `
            <div class="claim-row">
              <span class="claim-col-main">cRank ${fmt(r.cRank)}${packageTag ? ` ${packageTag}` : ''}</span>
              <span class="claim-col-eta">${eta}</span>
            </div>
          `;
        })
        .join('');

      const remaining = Math.max(0, pendingSorted.length - visible.length);
      const moreBtn = remaining > 0
        ? `<div class="claim-more-wrap"><button id="pendingShowMoreBtn" class="btn ghost" type="button">Show ${fmt(Math.min(25, remaining))} more</button></div>`
        : '';

      const summaryPills = [];
      if (under24hCount > 0) {
        summaryPills.push(`<span class="claim-stat-pill hot"><span class="pill-dot" aria-hidden="true"></span>&lt;24h ${fmt(under24hCount)}</span>`);
      }
      if (pendingLegacy.length > 0) {
        summaryPills.push(`<span class="claim-stat-pill legacy">Legacy ${fmt(pendingLegacy.length)}</span>`);
      }
      const summaryLine = summaryPills.length
        ? `<div class="claim-summary-line">${summaryPills.join('')}</div>`
        : '';

      pendingEl.innerHTML = `
        <div class="claim-warn"><b>${fmt(pending.length)} pending mint receipts</b></div>
        ${summaryLine}
        <div class="claim-list">${rows}</div>
        ${moreBtn}
      `;

      const showMoreBtn = pendingEl.querySelector('#pendingShowMoreBtn');
      if (showMoreBtn) {
        showMoreBtn.addEventListener('click', async () => {
          APP_STATE.pendingViewLimit = Math.min(pending.length, viewLimit + 25);
          await renderClaimStatus(address, state);
        });
      }

      ensureClaimCountdownTicker();
    } else {
      APP_STATE.pendingViewLimit = 25;
      pendingEl.textContent = 'None';
      stopClaimCountdownTicker();
    }

    if (claimable.length) {
      const chunks = [];
      const currentChunk = renderClaimableChunk(claimableCurrent, 'claimable', 'claim-ok');
      const legacyChunk = renderClaimableChunk(claimableLegacy, 'claimable (legacy package)', 'claim-muted');

      if (currentChunk) chunks.push(currentChunk);
      if (legacyChunk) chunks.push(legacyChunk);

      claimableEl.innerHTML = chunks.join('<div class="claim-sep"></div>');
    } else {
      claimableEl.textContent = 'None yet';
    }

    const pkgMismatches = receipts.filter((r) => !r.packageMatch).length;
    hintEl.textContent = `Found ${fmt(receipts.length)} mint receipt(s): ${fmt(pending.length)} pending, ${fmt(claimable.length)} claimable.`;
    if (pkgMismatches > 0) {
      hintEl.textContent += ` ${fmt(pkgMismatches)} legacy receipt(s) detected.`;
    }

    syncMintUiState();
    renderFeeSimulator(state);
  } catch (err) {
    APP_STATE.activeMintReceipt = null;
    APP_STATE.activeMintReceipts = [];
    APP_STATE.pendingViewLimit = 25;
    stopClaimCountdownTicker();
    console.error('Claim status read failed', err);
    hintEl.textContent = 'Claim status read failed. Please reconnect wallet and try again.';
    pendingEl.textContent = 'Unavailable';
    claimableEl.textContent = 'Unavailable';
    syncMintUiState();
    renderFeeSimulator(state);
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
  let autoReconnectAttempted = false;
  let unsubscribeWalletEvents = null;

  let getWallets;
  try {
    ({ getWallets } = await import('https://esm.sh/@wallet-standard/app@1.1.0'));
  } catch {
    setStatus('Wallet module failed to load. Refresh and try again.');
    return;
  }

  const api = getWallets();

  const clearWalletSubscription = () => {
    try {
      if (typeof unsubscribeWalletEvents === 'function') unsubscribeWalletEvents();
    } catch {}
    unsubscribeWalletEvents = null;
  };

  const normalizeAddress = (addr) => String(addr || '').trim().toLowerCase();

  const pickPreferredAccount = (target, maybeAccounts) => {
    const accounts = Array.from(maybeAccounts || target?.accounts || []);
    if (!accounts.length) return null;

    const preferredAddress = normalizeAddress(safeGet(WALLET_ADDR_KEY));
    return accounts.find((a) => normalizeAddress(a?.address) === preferredAddress) || accounts[0];
  };

  const bindWalletEvents = (target) => {
    clearWalletSubscription();
    const eventsFeature = target?.features?.['standard:events'];
    if (!eventsFeature?.on) return;

    unsubscribeWalletEvents = eventsFeature.on('change', ({ accounts }) => {
      const next = pickPreferredAccount(target, accounts);
      if (!next) {
        currentWallet = null;
        connectBtn.textContent = 'Connect';
        disconnectBtn.disabled = true;
        emitSession(null);
        refresh();
        return;
      }
      activateSession(target, next, { restored: true });
    });
  };

  const activateSession = (target, acc, { restored = false } = {}) => {
    currentWallet = target;
    connectBtn.textContent = shortAddress(acc.address);
    disconnectBtn.disabled = false;

    const accountChains = Array.from(acc?.chains || []);
    const supportsConfiguredChain = accountChains.includes(CHAIN_ID);
    if (!supportsConfiguredChain) {
      setStatus(`Connected: ${target.name}. Switch wallet network to ${CHAIN_CONFIG.networkLabel} (${CHAIN_ID}) to transact.`);
      showTxPopup('error', 'Network mismatch', `This wallet/account is not on ${CHAIN_ID}. Switch network before mint/stake/claim.`);
    } else {
      setStatus(restored ? `Reconnected: ${target.name}` : `Connected: ${target.name}`);
    }

    safeSet(WALLET_AUTO_KEY, '1');
    safeSet(WALLET_PREF_KEY, target.name || '');
    safeSet(WALLET_ADDR_KEY, acc.address || '');

    bindWalletEvents(target);

    const session = {
      wallet: target,
      account: acc,
      address: acc.address,
      chain: CHAIN_ID,
    };
    emitSession(session);
  };

  const refresh = async () => {
    wallets = (api.get() || []).filter((w) => Array.from(w.chains || []).some((c) => String(c).startsWith('iota:')));

    if (!wallets.length) {
      clearWalletSubscription();
      currentWallet = null;
      connectBtn.disabled = false;
      connectBtn.textContent = 'Get IOTA Wallet';
      disconnectBtn.disabled = true;
      setStatus('No compatible IOTA wallet found. You can still browse in read-only mode, or install the extension to transact.');
      emitSession(null);
      return;
    }

    if (currentWallet && !wallets.some((w) => w.name === currentWallet?.name)) {
      clearWalletSubscription();
      currentWallet = null;
      emitSession(null);
    }

    // Auto-restore on refresh: first from already-exposed accounts, then silent connect once.
    if (!currentWallet && safeGet(WALLET_AUTO_KEY) === '1') {
      const preferredName = safeGet(WALLET_PREF_KEY);
      const target = wallets.find((w) => w.name === preferredName) || wallets[0];
      const exposed = pickPreferredAccount(target, target?.accounts);
      if (target && exposed) {
        activateSession(target, exposed, { restored: true });
        return;
      }

      if (!autoReconnectAttempted && target) {
        autoReconnectAttempted = true;
        const connectFeature = target.features?.['standard:connect'];
        if (connectFeature?.connect) {
          try {
            setStatus(`Reconnecting: ${target.name}...`);
            const res = await connectFeature.connect({ silent: true });
            const rehydrated = pickPreferredAccount(target, res?.accounts || target?.accounts);
            if (rehydrated) {
              activateSession(target, rehydrated, { restored: true });
              return;
            }
          } catch {
            // Ignore silent reconnect failures and fall back to manual connect.
          }
        }
      }
    }

    connectBtn.disabled = false;
    disconnectBtn.disabled = !currentWallet;
    if (!currentWallet) {
      connectBtn.textContent = 'Connect';
      const primary = wallets[0]?.name || 'wallet';
      const more = wallets.length > 1 ? ` (+${wallets.length - 1} more detected)` : '';
      setStatus(`Wallet detected: ${primary}${more}. Connect to transact, or keep browsing in read-only mode.`);
    }
  };

  connectBtn.onclick = async () => {
    const target = wallets[0];
    if (!target) {
      window.open(WALLET_DOWNLOAD_URL, '_blank', 'noopener,noreferrer');
      setStatus('Opened wallet download page. Install extension for transactions; read-only mode remains available.');
      return;
    }

    try {
      const connectFeature = target.features?.['standard:connect'];
      if (!connectFeature?.connect) throw new Error('Wallet does not support connect');
      const res = await connectFeature.connect();
      const acc = pickPreferredAccount(target, res?.accounts || target?.accounts);
      if (!acc) throw new Error('No account returned');

      autoReconnectAttempted = false;
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
      clearWalletSubscription();
      currentWallet = null;
      autoReconnectAttempted = false;
      connectBtn.textContent = 'Connect';
      disconnectBtn.disabled = true;
      emitSession(null);
      safeDel(WALLET_AUTO_KEY);
      safeDel(WALLET_PREF_KEY);
      safeDel(WALLET_ADDR_KEY);
      refresh();
      if (!wallets.length) setStatus('Disconnected.');
    }
  };

  api.on('register', () => {
    refresh();
  });
  api.on('unregister', () => {
    refresh();
  });
  await refresh();
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

  if (APP_STATE.protocolPollTimer) {
    window.clearInterval(APP_STATE.protocolPollTimer);
  }
  APP_STATE.protocolPollTimer = window.setInterval(() => {
    refreshProtocolState(state);
  }, 12000);

  setText('#stamp', `Updated: ${new Date().toLocaleString()}`);
}

main().catch((err) => {
  console.error(err);
  setText('#walletStatus', `Error: ${err?.message || err}`);
});


