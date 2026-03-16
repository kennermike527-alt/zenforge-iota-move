# ZenForge GitHub Publish (No-Input Prep Ready)

This project is prepared for GitHub export as far as possible without account credentials.

## 1) Run local preflight

```powershell
powershell -ExecutionPolicy Bypass -File xen-iota-move/scripts/preflight.ps1
```

Checks performed:
- web data build
- website smoke checks
- on-chain protocol object read check
- Move unit tests (10/10)

## 2) Prepare standalone repo folder

```powershell
powershell -ExecutionPolicy Bypass -File xen-iota-move/scripts/prepare-github-repo.ps1
```

Default output:
- `C:\Users\gfhgh\.openclaw\workspace\tmp\zenforge-repo`

## 3) Create GitHub repo + push

Option A (manual): inside `tmp\zenforge-repo`

```powershell
git remote add origin https://github.com/<YOUR_USER>/<YOUR_REPO>.git
git push -u origin main
```

Option B (scripted):

```powershell
powershell -ExecutionPolicy Bypass -File xen-iota-move/scripts/push-github.ps1 -RemoteUrl "https://github.com/<YOUR_USER>/<YOUR_REPO>.git"
```


## 4) Optional post-push checks

- Open README and confirm package/protocol IDs are correct for target network.
- Verify `reports/onchain-check-latest.json` is fresh.
- Confirm website renders from `web/index.html` and reads live RPC as expected.

## Notes

- Current website supports live protocol reads via `iota_getObject` and falls back to simulation if RPC/object is unavailable.
- `iota_view` is not available on testnet at time of implementation, so AMP/APY are derived from live genesis timestamp using contract formulas.
