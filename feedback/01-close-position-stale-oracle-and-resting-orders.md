# Bug Report 01: `closePosition()` in `@dreamdex-bot-kit/perp-core` Aborts on Stale Oracle Mark (`priceable: false`) & Omits Resting-Order Cancellation, Breaking `perp-guard` Emergency De-Leveraging

- **Severity**: Critical / Major
- **Area**: `bot-kit` (`packages/perp-core/src/orders.ts`, `strategies/perp-guard/src/index.ts`)

## Steps to reproduce
1. Open a long or short perpetual position on Somnia Hideki Testnet (`chainId 50383`), or inspect `closePosition()` in `packages/perp-core/src/orders.ts` lines `240–313` alongside `strategies/perp-guard/src/index.ts` lines `61–69` and `183–204`.
2. **Case A (Stale Oracle / Halted Market)**:
   - Observe the comment in `strategies/perp-guard/src/index.ts:64-68`:
     ```ts
     // Every perp market on the venue, INCLUDING halted / unpriceable ones.
     // A market whose oracle just went stale is the one most worth watching;
     // filtering by `priceable` here would drop it from the pass.
     ```
   - Call `await closePosition(ctx, market)` when `tryGetHealthSnapshot` on the pool returns `ok = false` (`preview.priceable === false`).
3. **Case B (Account in `MarginCall` with a Resting Reduce Order on the Book)**:
   - Place a resting limit reduce order (e.g., a resting ask against a long position via `perp-maker` or a limit TP).
   - Call `await closePosition(ctx, market)` when account health drops below `EMERGENCY_RATIO` in `perp-guard`.

## Expected
1. **Case A**: During an oracle outage (`preview.priceable === false`), `closePosition()` should read the on-chain position directly from `MarginBank.getPosition(account, pool)` + `PerpPool.getOrderBookParameters()` and submit the reducing order against the resting order book, honoring the protocol's emergency-exit guarantee.
2. **Case B**: Before sending a market close for `|position.size|`, `closePosition()` must either cancel existing resting orders on the reducing side or clamp to `effectiveReducingCapacity`. Otherwise, `PerpPool._computeLockAmount` subtracts resting reducing orders from `_reducingCapacity`, treating the remainder of the close order as a **position-increasing leg (`increasingQuantity > 0`)** that locks collateral and enforces `meetsIMForOrder` — reverting with `InsufficientCollateral` or `InsufficientMarginForOrder` on unhealthy/margin-call accounts.

## Actual
1. In `packages/perp-core/src/orders.ts:240-256`, `closePosition()` calls `previewPerpClosePnl` and unconditionally returns `{ sent: false, filled: 0n }` whenever `!preview.priceable`. As a result, `perp-guard` cannot close or scale down any position when an oracle feed goes stale.
2. `closePosition()` does not cancel resting reducing orders or clamp to `effectiveReducingCapacity`, causing emergency closes to revert when a resting TP or maker quote is on the book.

## Evidence
- `packages/perp-core/src/orders.ts` lines `224–313`
- `strategies/perp-guard/src/index.ts` lines `64–69`, `183–204`
- `@somnia-chain/markets-sdk/src/perp/margin.ts` lines `3096–3104`

## Environment
- Network: Somnia Tokyo / Hideki Testnet (`chainId 50383`)
- SDK version: `@somnia-chain/markets-sdk@0.30.0` / `0.32.1`
- Commit: `somnia-chain/dreamdex-bot-kit` (`main`)
- OS / Runtime: Linux x86_64, Node.js `v26.12.0`
