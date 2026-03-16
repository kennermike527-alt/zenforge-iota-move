# XEN-on-IOTA (Move) — Initial Port

This package is a first-pass port of the XEN v1.7 litepaper mechanics onto IOTA Move.

## Location
- `xen-iota-move/move/xen`

## Included mechanics
- `claim_rank(term_days)`
- `claim_mint_reward()`
- `claim_mint_reward_and_share(other, pct)`
- `claim_mint_reward_and_stake(pct, stake_term_days)`
- `stake(coin, amount, term_days)`
- `withdraw()`

## Core formulas implemented
- Free mint term limit:
  - `100` when `global_rank <= 5000`
  - `100 + floor(log2(global_rank)) * 15` otherwise
- AMP:
  - starts at `3000`, decreases `1/day`, floor `1`
- EAA:
  - starts at `10%`, decreases `0.1%` per `100,000` rank
- Reward:
  - `floor(log2(rank_delta)) * term * AMP * (1 + EAA)`
- Late-claim penalty schedule:
  - `0,1,3,8,17,35,72,99` (>=7 days late => 99%)
- Staking APY:
  - starts at `20%`, decreases by `1%` every `90 days`, floor `2%`

## Notes / deviations
- Uses integer math (basis points) for deterministic Move execution.
- `rank_delta` is clamped to at least `1` to avoid `log2(0)` edge case.
- Genesis time is initialized from `tx_context::epoch_timestamp_ms` at publish.
- Active mint/stake states are tracked in protocol tables to prevent duplicate active positions.

## Build
From workspace root:

```powershell
& C:\Users\gfhgh\.openclaw\workspace\tools\iota\iota.exe move build --skip-fetch-latest-git-deps
```

(or run in package dir)

```powershell
& C:\Users\gfhgh\.openclaw\workspace\tools\iota\iota.exe move build --skip-fetch-latest-git-deps
```

## Tests
Run from package dir:

```powershell
& C:\Users\gfhgh\.openclaw\workspace\tools\iota\iota.exe move test --skip-fetch-latest-git-deps
```

Current status: 10/10 tests passing (includes e2e maturity/late-penalty and stake/withdraw flows).

## Testnet scenario script

Script:
- `xen-iota-move/scripts/testnet-scenario.ps1`

Example run:

```powershell
powershell -ExecutionPolicy Bypass -File xen-iota-move/scripts/testnet-scenario.ps1 -ClaimTermDays 7
```

This script:
1. Switches to testnet
2. Publishes package
3. Calls `claim_rank`
4. Prints package/protocol/receipt ids

## Latest verified testnet run
- Publish digest: `4XKr62ceCc21kiU7XFMatRqFsDgPkad44SWkStJgrSPn`
- Package ID: `0xa77f492c82c6f886801067a7b4a7c2eafe26b1f165ec2ae77539464d57ff2567`
- Protocol ID: `0xdbae4eb086afd1448d41306a5ad9c29fa48d802ace9d29dab857b543ee8e0c6f`
- Claim tx digest: `e5dypARswSVQA7wB7JpxdRxCCNK2npsdzBUWa2j5s4u`
- MintReceipt: `0x62dd5d2f34c359568c4d41ecc99744c11f05dcfca019159e8ba9c5c44a7a8be6`

## Deterministic simulation harness
Script:
- `xen-iota-move/scripts/simulate-tokenomics.mjs`

Run default scenario:

```powershell
node xen-iota-move/scripts/simulate-tokenomics.mjs
```

Run custom scenario:

```powershell
node xen-iota-move/scripts/simulate-tokenomics.mjs --config xen-iota-move/scripts/sim.config.example.json
```

Write baseline snapshot (default path: `xen-iota-move/baselines/default.baseline.json`):

```powershell
node xen-iota-move/scripts/simulate-tokenomics.mjs --write-baseline
```

Check current run against baseline (PASS/FAIL):

```powershell
node xen-iota-move/scripts/simulate-tokenomics.mjs --check-baseline
```

Run invariant assertions (economic safety checks):

```powershell
node xen-iota-move/scripts/simulate-tokenomics.mjs --assert-invariants
```

Use custom baseline path:

```powershell
node xen-iota-move/scripts/simulate-tokenomics.mjs --config xen-iota-move/scripts/sim.config.example.json --baseline xen-iota-move/baselines/custom.baseline.json --write-baseline
node xen-iota-move/scripts/simulate-tokenomics.mjs --config xen-iota-move/scripts/sim.config.example.json --baseline xen-iota-move/baselines/custom.baseline.json --check-baseline
```

Attack pack runner (spam rank / late claim wave / stake churn):

```powershell
# First time: write baselines + check + invariants
node xen-iota-move/scripts/run-attack-pack.mjs --write-baselines --check-baselines

# Normal CI-style run
node xen-iota-move/scripts/run-attack-pack.mjs --check-baselines
```

Outputs are written to:
- `xen-iota-move/reports/sim-<timestamp>/`
  - `summary.md`
  - `replay.json`
  - `timeline.csv`
  - `claims.csv`
  - `stakes.csv`
  - `baseline.current.json`

## Website (purple/orange design pass v2)
Dynamic local site files:
- `xen-iota-move/web/index.html`
- `xen-iota-move/web/styles.css`
- `xen-iota-move/web/app.js`
- `xen-iota-move/scripts/build-web-data.mjs`
- `xen-iota-move/web/data/latest.json`

Refresh website data from latest simulation artifacts:

```powershell
node xen-iota-move/scripts/build-web-data.mjs
```

Then open `web/index.html` directly in browser (or serve with any static server).

## GitHub handoff (prepared)

Run full local validation:

```powershell
powershell -ExecutionPolicy Bypass -File xen-iota-move/scripts/preflight.ps1
```

Prepare standalone export repo:

```powershell
powershell -ExecutionPolicy Bypass -File xen-iota-move/scripts/prepare-github-repo.ps1
```

Then follow:
- `xen-iota-move/GITHUB_PUBLISH.md`

## Next steps
1. Validate reward vectors against litepaper examples line-by-line and lock expected outputs.
2. Add docs for token distribution and optional burn/integration hooks.
3. Publish audited release package and pin canonical IDs.
4. Add a tiny CLI wrapper for one-command run+diff against prior simulation baselines.
