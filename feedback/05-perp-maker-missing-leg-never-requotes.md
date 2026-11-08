# Bug Report 05: `perp-maker` Silently Stops Quoting a Side Forever After a Single `PostOnlyWouldCross` or `MAX_POSITION` Skip

- **Severity**: Major
- **Area**: `bot-kit` (`strategies/perp-maker/src/index.ts`, `packages/perp-core/src/orders.ts`)

## Steps to reproduce
1. Inspect `packages/perp-core/src/orders.ts:189-192`:
   ```ts
   if (err instanceof ContractRevertError && err.errorName === "PostOnlyWouldCross") {
     console.log(`  ${side} post-only would have crossed the book — skipped rather than paying the spread. Re-quotes next cycle.`);
     return { sent: false, rested: false, filled: 0n };
   }
   ```
2. Inspect `strategies/perp-maker/src/index.ts:123-151`:
   ```ts
   const drift = resting.atMark ? Math.abs(mark - resting.atMark) / resting.atMark : Infinity;
   if (drift < REQUOTE_BPS / 10_000 && (resting.bid || resting.ask)) {
     await sleep(REFRESH_SEC * 1000);
     continue;
   }
   ```
3. Run `perp-maker` when the order book spread is narrower than `SPREAD_BPS` on one side (so `bid` rests (`resting.bid = "123"`), while `ask` reverts `PostOnlyWouldCross` and `quoteSide` returns `undefined`).

## Expected
- When a wanted leg (`allowBid && !resting.bid` or `allowAsk && !resting.ask`) is missing because it was skipped on the previous cycle, the next cycle should attempt to place the missing leg even if `drift < REQUOTE_BPS / 10_000`.
- `quoteSide()` (`perp-maker/src/index.ts:160`) should also pass `tradingKey: ctx.tradingKey` to `sizeOrder`.

## Actual
- Because line 124 checks `(resting.bid || resting.ask)` instead of verifying that all allowed sides are resting (`(!allowBid || resting.bid) && (!allowAsk || resting.ask)`), as long as one leg rested and `drift < REQUOTE_BPS / 10_000`, `perp-maker` sleeps and skips re-quoting on every subsequent cycle, leaving the market maker one-sided indefinitely.

## Evidence
- `strategies/perp-maker/src/index.ts` lines `123–151` and `160–162`
- `packages/perp-core/src/orders.ts` lines `189–192`

## Environment
- Network: Somnia Tokyo / Hideki Testnet (`chainId 50383`)
- Package: `@dreamdex-bot-kit/strategy-perp-maker@0.1.0`
- OS / Runtime: Linux x86_64, Node.js `v26.12.0`
