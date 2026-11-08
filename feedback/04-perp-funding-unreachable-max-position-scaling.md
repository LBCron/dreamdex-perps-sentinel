# Bug Report 04: `perp-funding` Carry Bot Never Scales Up to `MAX_POSITION` Due to Unreachable `!position` Guard Around `held >= MAX_POSITION`

- **Severity**: Major
- **Area**: `bot-kit` (`strategies/perp-funding/src/index.ts`)

## Steps to reproduce
1. Inspect `strategies/perp-funding/src/index.ts` lines `99–149`:
   ```ts
   const position = await positionIn(ctx.exchange, market);
   const liveAt = liveMark(market) ?? funding.mark;
   const held = position ? position.contracts * liveAt : 0;
   ...
   } else if (!position && worthHolding && me) {
     if (held >= MAX_POSITION) {
       console.log("  at the position cap, not adding.");
     } else {
       const addNotional = Math.min(NOTIONAL, MAX_POSITION - held);
   ```
2. Configure `PERP_FUNDING_NOTIONAL_USDSO=50` and `PERP_FUNDING_MAX_POSITION_USDSO=200`.
3. Run `perp-funding` across two or more poll cycles while `funding.apr >= ENTER_APR`.

## Expected
- The bot should scale into the carry position in `NOTIONAL` (`$50`) increments across poll cycles up to `MAX_POSITION` (`$200`) as long as `worthHolding` (`funding.apr >= ENTER_APR`) holds and the existing position is on the paying side (`position.side === paySide`).

## Actual
- Line 126 guards the entire entry/scaling block with `else if (!position && worthHolding && me)`.
- Inside that branch, `position` is always `undefined`, so `held` is always `0`.
- `if (held >= MAX_POSITION)` on line 127 is unreachable dead code, and once Cycle 1 opens the initial `$50` slice, `position` becomes truthy on Cycle 2+, so the bot never adds another slice up to `MAX_POSITION` (`$200`).

## Evidence
- `strategies/perp-funding/src/index.ts` lines `101` and `126–151`.

## Environment
- Network: Somnia Tokyo / Hideki Testnet (`chainId 50383`)
- Package: `@dreamdex-bot-kit/strategy-perp-funding@0.1.0`
- OS / Runtime: Linux x86_64, Node.js `v26.12.0`
