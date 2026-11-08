# Bug Report 07: `preflight()` Under-Estimates Required Margin When Account Leverage Cap Is Stricter Than Market Ceiling, Order Has Adverse Mark-to-Entry Gap, or Dynamic OI-Scaled IMF Applies

- **Severity**: Major
- **Area**: `bot-kit` (`packages/perp-core/src/margin.ts`, `strategies/perp-starter/src/index.ts`, `strategies/perp-funding/src/index.ts`)

## Steps to reproduce
1. Inspect `strategies/perp-starter/src/index.ts` lines `86–95` and `strategies/perp-funding/src/index.ts` lines `80–83`:
   ```ts
   const ready = await preflight(ctx, {
     market,
     requiredUsdso: NOTIONAL / Math.max(1, LEVERAGE),
   });
   ```
2. Run with `PERP_STARTER_LEVERAGE=20` on a `10x` max-leverage market (`DOGE-PERP`, `TAO-PERP`, `1000PEPE-PERP`, where `initialMarginBps = 1000` = `10%`), or run in trading-key mode (`OWNER_ADDRESS`) where the owner account has a stricter on-chain leverage cap (`getMaxLeverage < LEVERAGE`).

## Expected
- `preflight()` (and `marginForNotional()`) should compute the effective initial margin requirement using `Math.max(effectiveImfBps / 10_000, 1 / effectiveAccountLeverage)` plus taker/slippage adverse-gap buffer.

## Actual
- `preflight()` checks `NOTIONAL / LEVERAGE` (`$50 / 20 = 2.5 USDso` when the pool requires at least `10% = 5.0 USDso`), passing preflight with insufficient collateral and failing immediately on the first order sizing call.
- Additionally, `marginForNotional(notionalUsdso, market)` in `packages/perp-core/src/margin.ts:156-160` is exported by `perp-core` (and ignores both `effectiveImfBps` and account leverage caps) and is never called anywhere in the repo.

## Evidence
- `packages/perp-core/src/margin.ts` lines `76–160`
- `strategies/perp-starter/src/index.ts` lines `86–95`
- `strategies/perp-funding/src/index.ts` lines `80–83`

## Environment
- Network: Somnia Tokyo / Hideki Testnet (`chainId 50383`)
- Package: `@dreamdex-bot-kit/perp-core@0.1.0`
- OS / Runtime: Linux x86_64, Node.js `v26.12.0`
