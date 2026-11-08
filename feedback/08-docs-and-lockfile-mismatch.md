# Bug Report 08: Official Perps Developer Docs & `dreamdex-bot-kit` Lockfile Mismatch (`SOMNIA_HIDEKI_TESTNET_ADDRESSES` Missing in Locked `0.30.0`, Outdated Margin/Leverage Table, Incomplete Root Build)

- **Severity**: Minor / Docs
- **Area**: `docs` / `bot-kit` (`https://app.testnet.dreamdex.io/docs/developers/perps-testnet`, `https://app.testnet.dreamdex.io/docs/trading/perps-testnet`, `dreamdex-bot-kit/package.json`)

## Steps to reproduce
1. **Docs Quickstart Import Failure in `dreamdex-bot-kit`**:
   - Open `https://app.testnet.dreamdex.io/docs/developers/perps-testnet`. The quickstart imports `SOMNIA_HIDEKI_TESTNET_ADDRESSES` from `@somnia-chain/markets-sdk`.
   - In `somnia-chain/dreamdex-bot-kit`, `packages/perp-core/package.json` specifies `"@somnia-chain/markets-sdk": "^0.31.0"`, while `package-lock.json` locks `@somnia-chain/markets-sdk` to `0.30.0` (and `packages/perp-core/node_modules/@somnia-chain/markets-sdk` to `0.32.1`), causing top-level scripts importing `@somnia-chain/markets-sdk` to resolve `0.30.0` where `SOMNIA_HIDEKI_TESTNET_ADDRESSES` is `undefined`.
2. **Outdated Market Margin & Max Leverage Table in `docs/trading/perps-testnet`**:
   - `https://app.testnet.dreamdex.io/docs/trading/perps-testnet` lists 21 markets with outdated Initial Margin / Maintenance Margin / Max Leverage compared to live Hideki (`chainId 50383`) pools:
     - `BTC-PERP`, `ETH-PERP`, `SOL-PERP`, `HYPE-PERP` are live at `250 bps` (`2.5%`) IM / `125 bps` (`1.25%`) MM / `40x` Max Leverage (docs say `5%/20x` or `10%/10x`).
     - `1000PEPE-PERP`, `LIT-PERP`, `PUMP-PERP`, `TAO-PERP`, `VVV-PERP`, `WLD-PERP`, `ZEC-PERP`, `ZRO-PERP` are live at `1000 bps` (`10%`) IM / `500 bps` (`5%`) MM / `10x` Max Leverage (docs say `20%/5x`).
     - 22nd market `ADLT-PERP` (`0x90a9942a2ebac6d8816c63718d3540a57f998249`, `2000 bps` IM = `5x`) is live on Hideki (`50383`) and missing from the docs table.
3. **Incomplete Root Build & Agent Skills in `dreamdex-bot-kit`**:
   - Root `package.json` `"build"` script only builds `@dreamdex-bot-kit/core` and `@dreamdex-bot-kit/backtest`, omitting `@dreamdex-bot-kit/perp-core` and `@dreamdex-bot-kit/ec-core`.
   - `skills/somnia/SKILL.md` and `skills/dreamdex-bot/SKILL.md` omit Hideki/Tokyo Testnet (`50383`) and `@dreamdex-bot-kit/perp-core`.

## Expected
- Root `package-lock.json` should resolve `@somnia-chain/markets-sdk >= 0.32.1` consistently across the workspace.
- `docs/trading/perps-testnet` table should reflect the live Hideki (`50383`) `40x` / `20x` / `10x` / `5x` parameters and include `ADLT-PERP`.
- Root `package.json` `"build"` script and `skills/*.md` should include `@dreamdex-bot-kit/perp-core` and Hideki (`50383`).

## Actual
- Top-level `@somnia-chain/markets-sdk` resolves to `0.30.0` where `SOMNIA_HIDEKI_TESTNET_ADDRESSES` is `undefined`; docs table under-states max leverage by 2x–4x across 12 markets; `npm run build` skips `perp-core`.

## Evidence
```text
Found 22 perp market(s):
  1000PEPE-PERP      mark $0.003689    IM 1000bps (10x)  MM 500bps   pool 0xf1b26835be…
  ADLT-PERP          mark $1           IM 2000bps (5x)   MM 1000bps  pool 0x90a9942a2e…
  BTC-PERP           mark $75,821.33   IM 250bps (40x)   MM 125bps   pool 0x3b8aa132d0…
  ETH-PERP           mark $2,356.71    IM 250bps (40x)   MM 125bps   pool 0x052889598b…
  HYPE-PERP          mark $42.44       IM 250bps (40x)   MM 125bps   pool 0xf08ba12922…
  SOL-PERP           mark $88.24       IM 250bps (40x)   MM 125bps   pool 0xdf3b47908c…
```

## Environment
- Network: Somnia Tokyo / Hideki Testnet (`chainId 50383`)
- Docs URLs: `https://app.testnet.dreamdex.io/docs/developers/perps-testnet`, `https://app.testnet.dreamdex.io/docs/trading/perps-testnet`
- Repo: `https://github.com/somnia-chain/dreamdex-bot-kit`
