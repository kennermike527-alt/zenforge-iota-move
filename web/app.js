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
const APP_STATE = {
  protocol: null,
  walletSession: null,
  activeMintReceipt: null,
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

function feeAtTerm(day, minFee, maxFee, maxTerm = 365) {
  return minFee + ((maxFee - minFee) * (maxTerm - day)) / (maxTerm - 1);
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
  const termInput = document.querySelector('#simTermDays');
  const ampInput = document.querySelector('#simAmp');
  const minInput = document.querySelector('#simMinFee');
  const maxInput = document.querySelector('#simMaxFee');

  const output = document.querySelector('#feeOutput');
  const formulaOutput = document.querySelector('#feeFormulaOutput');
  const feeNote = document.querySelector('#feeNote');
  const simStateNote = document.querySelector('#simStateNote');

  if (!rankInput || !termInput || !ampInput || !minInput || !maxInput || !output || !formulaOutput) return;

  // Pre-populate from current protocol state (live or fallback)
  const lockedAmp = Math.max(1, Math.floor(Number(state.amp || 3000)));
  rankInput.value = String(Math.max(1, Math.floor(Number(state.globalRank || 1))));
  termInput.value = String(Math.min(100, Math.max(1, Math.floor(Number(state.maxTerm || 100)))));
  ampInput.value = String(lockedAmp);
  ampInput.readOnly = true;

  const update = () => {
    const rank = Math.max(1, Math.floor(Number(rankInput.value || 1)));
    let termDays = Math.max(1, Math.floor(Number(termInput.value || 30)));
    termDays = Math.min(100, termDays);
    termInput.value = String(termDays);

    ampInput.value = String(lockedAmp);

    let minFee = Number(minInput.value || 0.005);
    let maxFee = Number(maxInput.value || 0.05);
    if (!Number.isFinite(minFee)) minFee = 0.005;
    if (!Number.isFinite(maxFee)) maxFee = 0.05;
    if (maxFee < minFee) {
      const t = maxFee;
      maxFee = minFee;
      minFee = t;
      minInput.value = String(minFee);
      maxInput.value = String(maxFee);
    }

    const impliedMaxTerm = freeMintTermLimitForRank(rank);
    const selectedFee = feeAtTerm(termDays, minFee, maxFee);

    output.innerHTML = [
      `<b>Selected term:</b> ${termDays} days`,
      `<b>Simulated fee charged:</b> ${selectedFee.toFixed(6)} IOTA`,
      `<b>Fee range:</b> day 1 = ${maxFee.toFixed(6)} IOTA, day 365 = ${minFee.toFixed(6)} IOTA`,
      `<b>Current simulator state:</b> rank ${fmt(rank)}, AMP ${fmt(lockedAmp)} (locked)`,
    ].join('<br/>');

    formulaOutput.innerHTML = [
      '<b>Fee formula (policy model):</b>',
      '<code>fee(day) = minFee + ((maxFee - minFee) × (365 - day)) / 364</code>',
      `<b>Current inputs:</b> minFee=${minFee.toFixed(6)}, maxFee=${maxFee.toFixed(6)}, day=${termDays}`,
      `<b>Computed fee:</b> ${selectedFee.toFixed(6)} IOTA`,
    ].join('<br/>');

    if (simStateNote) {
      simStateNote.textContent = `Formula-implied max term from rank is ${fmt(impliedMaxTerm)} days. AMP is locked to the current protocol value in this simulator.`;
    }

    if (feeNote) feeNote.textContent = 'Fee model shown above is currently UI policy simulation, not enforced on-chain yet.';
  };

  ['input', 'change'].forEach((evt) => {
    rankInput.addEventListener(evt, update);
    termInput.addEventListener(evt, update);
    minInput.addEventListener(evt, update);
    maxInput.addEventListener(evt, update);
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
  if (!listEl) return;

  if (!address) {
    listEl.innerHTML = '<div class="stake-item">Connect wallet to view your stakes.</div>';
    if (txStatus) txStatus.textContent = 'Connect wallet to enable staking.';
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

    if (!stakes.length) {
      listEl.innerHTML = '<div class="stake-item">No active stake receipts found.</div>';
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
  } catch (err) {
    listEl.innerHTML = `<div class="stake-item">Failed to load stakes: ${err?.message || err}</div>`;
  }
}

async function renderStakeCoinOptions(address, state) {
  const selectEl = document.querySelector('#stakeCoinSelect');
  const stakeBtn = document.querySelector('#stakeNowBtn');
  if (!selectEl) return;

  if (!address) {
    selectEl.innerHTML = '<option value="">Connect wallet first</option>';
    if (stakeBtn) stakeBtn.disabled = true;
    return;
  }

  selectEl.innerHTML = '<option value="">Loading XENI coins...</option>';

  try {
    const packageId = state.packageId || CHAIN_CONFIG.packageId;
    const coinType = `${packageId}::xen::XEN`;
    const coins = await rpcCall('iotax_getCoins', [address, coinType, null, 50]);
    const data = coins?.data || [];

    if (!data.length) {
      selectEl.innerHTML = '<option value="">No XENI coin objects found</option>';
      if (stakeBtn) stakeBtn.disabled = true;
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
  } catch (err) {
    selectEl.innerHTML = `<option value="">Failed to load coins: ${(err?.message || err).replace(/"/g, '&quot;')}</option>`;
    if (stakeBtn) stakeBtn.disabled = true;
  }
}

async function executeStakeTx(state) {
  const session = APP_STATE.walletSession;
  const statusEl = document.querySelector('#stakeTxStatus');
  const amountInput = document.querySelector('#stakeAmount');
  const termInput = document.querySelector('#stakeTermDays');
  const coinSelect = document.querySelector('#stakeCoinSelect');
  const stakeBtn = document.querySelector('#stakeNowBtn');

  if (!session?.wallet || !session?.account) {
    if (statusEl) statusEl.textContent = 'Connect wallet first.';
    return;
  }
  if (!amountInput || !termInput || !coinSelect) return;

  const amountHumanText = String(amountInput.value || '').trim().replace(/,/g, '.');
  const amountRaw = parseUnits(amountHumanText, TOKEN_DECIMALS);
  const termDays = Math.floor(Number(termInput.value || 0));
  const coinId = String(coinSelect.value || '').trim();

  if (!coinId) {
    if (statusEl) statusEl.textContent = 'Select a XENI coin object.';
    return;
  }
  if (!amountRaw || amountRaw <= 0n) {
    if (statusEl) statusEl.textContent = 'Enter a valid stake amount in XENI (e.g., 1.25).';
    return;
  }
  if (amountRaw > U64_MAX) {
    if (statusEl) statusEl.textContent = 'Stake amount is too large for u64.';
    return;
  }
  if (termDays < 1 || termDays > 1000) {
    if (statusEl) statusEl.textContent = 'Stake term must be between 1 and 1000 days.';
    return;
  }

  try {
    if (stakeBtn) stakeBtn.disabled = true;
    if (statusEl) statusEl.textContent = `Preparing stake transaction for ${amountHumanText} XENI...`;

    const { Transaction } = await import('https://esm.sh/@iota/iota-sdk/transactions');
    const tx = new Transaction();

    tx.moveCall({
      target: `${state.packageId || CHAIN_CONFIG.packageId}::xen::stake`,
      arguments: [
        tx.object(CHAIN_CONFIG.protocolId),
        tx.object(CHAIN_CONFIG.clockId),
        tx.object(coinId),
        tx.pure.u64(amountRaw),
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

function setupStakingUi(state) {
  const refreshBtn = document.querySelector('#refreshStakeCoins');
  const stakeBtn = document.querySelector('#stakeNowBtn');
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

async function loadActiveMintReceipt(address, state) {
  if (!address) return null;
  const packageId = state.packageId || CHAIN_CONFIG.packageId;
  const objects = await fetchOwnedObjects(address, 6);
  const receipt = objects.find((o) => String(o?.data?.type || '').endsWith('::xen::MintReceipt'));
  if (!receipt) return null;

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
}

function syncMintUiState() {
  const mintBtn = document.querySelector('#mintNowBtn');
  const claimBtn = document.querySelector('#claimMintBtn');
  const statusEl = document.querySelector('#mintTxStatus');

  if (!mintBtn || !claimBtn || !statusEl) return;

  const session = APP_STATE.walletSession;
  const receipt = APP_STATE.activeMintReceipt;

  if (!session) {
    mintBtn.disabled = true;
    claimBtn.disabled = true;
    statusEl.textContent = 'Connect wallet to enable mint actions.';
    return;
  }

  mintBtn.disabled = false;

  if (!receipt) {
    claimBtn.disabled = true;
    statusEl.textContent = 'No active mint receipt. Start a mint to create one.';
    return;
  }

  claimBtn.disabled = !receipt.matured;

  if (!receipt.matured) {
    const daysLeft = Math.max(0, Math.ceil((receipt.maturityMs - Date.now()) / DAY_MS));
    statusEl.textContent = `Active mint receipt detected. Claim unlocks in ~${fmt(daysLeft)} day(s).`;
  } else {
    statusEl.textContent = 'Matured mint receipt ready. You can claim mint reward now.';
  }
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
    if (statusEl) statusEl.textContent = `Mint failed: ${err?.message || err}`;
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

    let receipt = APP_STATE.activeMintReceipt;
    if (!receipt) {
      receipt = await loadActiveMintReceipt(session.address, state);
      APP_STATE.activeMintReceipt = receipt;
    }
    if (!receipt) {
      if (statusEl) statusEl.textContent = 'No active mint receipt found.';
      return;
    }
    if (!receipt.matured) {
      if (statusEl) statusEl.textContent = 'Mint receipt not matured yet.';
      return;
    }

    if (statusEl) statusEl.textContent = 'Preparing claim reward transaction...';

    const { Transaction } = await import('https://esm.sh/@iota/iota-sdk/transactions');
    const tx = new Transaction();

    tx.moveCall({
      target: `${state.packageId || CHAIN_CONFIG.packageId}::xen::claim_mint_reward`,
      arguments: [
        tx.object(CHAIN_CONFIG.protocolId),
        tx.object(CHAIN_CONFIG.clockId),
        tx.object(receipt.id),
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

    if (statusEl) statusEl.textContent = `Claim submitted. Digest: ${res?.digest || 'submitted'}`;

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
    hintEl.textContent = 'Connect wallet to load your mint receipt status.';
    pendingEl.textContent = '-';
    claimableEl.textContent = '-';
    syncMintUiState();
    return;
  }

  hintEl.textContent = `Loading claim status for ${address}...`;

  try {
    const receipt = await loadActiveMintReceipt(address, state);
    APP_STATE.activeMintReceipt = receipt;

    if (!receipt) {
      hintEl.textContent = 'No active mint receipt found for this wallet.';
      pendingEl.textContent = 'None';
      claimableEl.textContent = 'None';
      syncMintUiState();
      return;
    }

    const { cRank, termDays, maturityMs, ampAtClaim } = receipt;
    const nowMs = Date.now();

    if (nowMs < maturityMs) {
      const remainingDays = Math.ceil((maturityMs - nowMs) / DAY_MS);
      hintEl.textContent = 'You have an active mint receipt that is not matured yet.';
      pendingEl.innerHTML = `
        <div class="claim-warn"><b>Pending</b></div>
        cRank: ${fmt(cRank)}<br/>
        Term: ${fmt(termDays)} days<br/>
        AMP at claim: ${fmt(ampAtClaim)}<br/>
        Matures in: ${fmt(remainingDays)} day(s)
      `;
      claimableEl.textContent = 'None yet';
    } else {
      const daysLate = Math.floor((nowMs - maturityMs) / DAY_MS);
      const penalty = latePenaltyPct(daysLate);
      hintEl.textContent = 'You have a matured receipt. Claim timing penalty depends on lateness.';
      pendingEl.textContent = 'None';
      claimableEl.innerHTML = `
        <div class="claim-ok"><b>Claimable now</b></div>
        cRank: ${fmt(cRank)}<br/>
        Term: ${fmt(termDays)} days<br/>
        AMP at claim: ${fmt(ampAtClaim)}<br/>
        Days late: ${fmt(daysLate)}<br/>
        Current penalty band: ${penalty}%
      `;
    }

    if (!receipt.packageMatch) {
      hintEl.textContent += ' (note: receipt package differs from configured package id)';
    }
    syncMintUiState();
  } catch (err) {
    APP_STATE.activeMintReceipt = null;
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
  const addressEl = document.querySelector('#connectedAddress');

  if (!statusEl || !connectBtn || !disconnectBtn || !addressEl) return;

  const emitSession = (session) => {
    APP_STATE.walletSession = session || null;
    if (typeof onSessionChange === 'function') onSessionChange(APP_STATE.walletSession);
  };

  const setStatus = (t) => (statusEl.textContent = t);
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

  const refresh = () => {
    wallets = (api.get() || []).filter((w) => Array.from(w.chains || []).some((c) => String(c).startsWith('iota:')));

    if (!wallets.length) {
      connectBtn.disabled = true;
      disconnectBtn.disabled = true;
      setStatus('No compatible IOTA wallet found. Open/enable extension for localhost and refresh.');
      emitSession(null);
      return;
    }

    connectBtn.disabled = false;
    disconnectBtn.disabled = !currentWallet;
    if (!currentWallet) {
      const primary = wallets[0]?.name || 'wallet';
      const more = wallets.length > 1 ? ` (+${wallets.length - 1} more detected)` : '';
      setStatus(`Wallet detected: ${primary}${more}. Click Connect.`);
    }
  };

  connectBtn.onclick = async () => {
    const target = wallets[0];
    if (!target) {
      setStatus('No compatible wallet detected.');
      return;
    }

    try {
      const connectFeature = target.features?.['standard:connect'];
      if (!connectFeature?.connect) throw new Error('Wallet does not support connect');
      const res = await connectFeature.connect();
      const acc = res?.accounts?.[0] || target.accounts?.[0];
      if (!acc) throw new Error('No account returned');
      currentWallet = target;
      addressEl.textContent = acc.address;
      disconnectBtn.disabled = false;
      setStatus(`Connected: ${target.name}`);

      const session = {
        wallet: target,
        account: acc,
        address: acc.address,
        chain: (Array.from(acc.chains || []).find((c) => String(c).startsWith('iota:')) || CHAIN_ID),
      };
      emitSession(session);
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
      addressEl.textContent = '-';
      disconnectBtn.disabled = true;
      emitSession(null);
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
