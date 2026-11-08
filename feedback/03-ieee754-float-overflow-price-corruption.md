# Bug Report 03: IEEE-754 Float Overflow in `BigInt(Math.round(price * 1e18))` Across `closePosition`, `perp-starter`, `perp-maker`, and `perp-funding` Corrupts Order/Trigger Prices & Breaks Tick Alignment

- **Severity**: Major
- **Area**: `bot-kit` (`packages/perp-core/src/orders.ts`, `strategies/perp-starter/src/index.ts`, `strategies/perp-maker/src/index.ts`, `strategies/perp-funding/src/index.ts`)

## Steps to reproduce
1. Inspect the 7 call sites in `dreamdex-bot-kit` where a human USDso price is multiplied by `1e18` inside IEEE-754 double-precision float before passing to `BigInt(Math.round(...))`:
   - `packages/perp-core/src/orders.ts:293`
   - `strategies/perp-starter/src/index.ts:126, 174, 175, 223`
   - `strategies/perp-maker/src/index.ts:142, 143`
   - `strategies/perp-funding/src/index.ts:136`
2. Run with live `BTC-PERP` mark/touch price on Hideki (`~75,821.33 USDso`):
   ```ts
   const btcTouch = 75821.33;
   const corrupted = BigInt(Math.round(btcTouch * 1e18));
   console.log(corrupted.toString());
   ```

## Expected
- `75821.33 * 10^18` should equal `75821330000000000000000n` (`7.582133e22`), and watched-exit trigger prices (`takeProfit`, `stopLoss`) should be tick-aligned without binary floating-point drift.

## Actual
- Because `7.582133e22` exceeds `Number.MAX_SAFE_INTEGER` (`9.007e15`) by 8,400,000x, `BigInt(Math.round(btcTouch * 1e18))` evaluates to `75821330000000009109504n` (corrupted by `+9,109,504` wei).
- When `alignPrice` is called on float-overflowed values that sit on exact tick boundaries, negative float drift floors bids down by an extra tick and positive float drift ceils asks up by an extra tick.

## Evidence
```text
btcTouch                             = 75821.33
BigInt(Math.round(btcTouch * 1e18))  = 75821330000000009109504
exact 75821.33 * 1e18                = 75821330000000000000000
drift (wei)                          = 9109504
corrupted % tickSize (1e16)          = 9109504
```

## Environment
- Network: Somnia Tokyo / Hideki Testnet (`chainId 50383`)
- Package: `@dreamdex-bot-kit/perp-core@0.1.0`, `perp-starter`, `perp-maker`, `perp-funding`
- OS / Runtime: Linux x86_64, Node.js `v26.12.0`
