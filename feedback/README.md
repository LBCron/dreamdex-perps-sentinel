# dreamDEX Perps Builder Bounty — Track 1 Feedback & Bug Reports

Each bug report in this folder follows the DoraHacks **Track 1 — Feedback / Bug Hunt** template (`Severity`, `Area`, `Steps to reproduce`, `Expected`, `Actual`, `Evidence`, `Environment`) and is fixed + regression-tested inside `dreamdex-perps-sentinel`:

| File | Severity | Area | Summary |
| :--- | :---: | :--- | :--- |
| [`01-close-position-stale-oracle-and-resting-orders.md`](./01-close-position-stale-oracle-and-resting-orders.md) | **Critical / Major** | `bot-kit` / `sdk` | `closePosition()` aborts on stale oracle mark (`priceable: false`) & omits resting-order cancellation, breaking `perp-guard` emergency de-leveraging |
| [`02-toraw-precision-truncation-and-crash.md`](./02-toraw-precision-truncation-and-crash.md) | **Major** | `bot-kit` / `sdk` | `toRaw(human, decimals)` truncates precision at 9 decimal places (`Math.min(decimals, 9)`) and crashes with `SyntaxError` on `>= 1e21` |
| [`03-ieee754-float-overflow-price-corruption.md`](./03-ieee754-float-overflow-price-corruption.md) | **Major** | `bot-kit` | IEEE-754 float overflow in `BigInt(Math.round(price * 1e18))` across `closePosition`, `perp-starter`, `perp-maker`, and `perp-funding` corrupts prices & breaks tick alignment |
| [`04-perp-funding-unreachable-max-position-scaling.md`](./04-perp-funding-unreachable-max-position-scaling.md) | **Major** | `bot-kit` | `perp-funding` carry bot never scales up to `MAX_POSITION` due to unreachable `!position` guard around `held >= MAX_POSITION` |
| [`05-perp-maker-missing-leg-never-requotes.md`](./05-perp-maker-missing-leg-never-requotes.md) | **Major** | `bot-kit` | `perp-maker` silently stops quoting a side forever after a single `PostOnlyWouldCross` or `MAX_POSITION` skip |
| [`06-makechain-missing-multicall3-rpc-amplification.md`](./06-makechain-missing-multicall3-rpc-amplification.md) | **Major** | `bot-kit` / `sdk` | `makeChain()` in `@dreamdex-bot-kit/perp-core` omits `contracts.multicall3`, forcing `getPerpState()` into a 10x RPC amplification fallback |
| [`07-preflight-underestimates-effective-margin.md`](./07-preflight-underestimates-effective-margin.md) | **Major** | `bot-kit` | `preflight()` under-estimates required margin when account leverage cap is stricter than market ceiling, order has adverse mark-to-entry gap, or dynamic OI-scaled IMF applies |
| [`08-docs-and-lockfile-mismatch.md`](./08-docs-and-lockfile-mismatch.md) | **Minor / Docs** | `docs` / `bot-kit` | Official Perps developer docs & `dreamdex-bot-kit` lockfile mismatch (`SOMNIA_HIDEKI_TESTNET_ADDRESSES` missing in root `0.30.0`, outdated margin/leverage table, incomplete root build) |
