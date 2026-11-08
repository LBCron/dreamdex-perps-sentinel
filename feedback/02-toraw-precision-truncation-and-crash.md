# Bug Report 02: `toRaw(human, decimals)` in `@dreamdex-bot-kit/perp-core` Truncates Precision at 9 Fractional Digits (`Math.min(decimals, 9)`) and Throws `SyntaxError` on `>= 1e21`

- **Severity**: Major
- **Area**: `bot-kit` / `sdk` (`packages/perp-core/src/markets.ts`)

## Steps to reproduce
Run the following reproduction script in `dreamdex-bot-kit`:
```ts
import { toRaw } from "@dreamdex-bot-kit/perp-core";

console.log("toRaw(0.123456789123456, 24) =", toRaw(0.123456789123456, 24).toString());
console.log("toRaw(1e-10, 18)             =", toRaw(1e-10, 18).toString());
console.log("toRaw(1e21, 18)              =", toRaw(1e21, 18).toString());
```

## Expected
- `toRaw(0.123456789123456, 24)` should preserve all available significant digits (`123456789123456000000000n`), since `NEAR-PERP` on Hideki (`0x660b88318c7d4aa39a2ab98f942fb9cecf7a6ca3`) uses `baseDecimals = 24` and all perp collateral/prices use `18` decimals.
- `toRaw(1e-10, 18)` should return `100000000n` (`10^8` wei).
- `toRaw(1e21, 18)` should not throw an unhandled `SyntaxError` inside `BigInt(...)`.

## Actual
In `packages/perp-core/src/markets.ts:131-138`:
```ts
export function toRaw(human: number, decimals: number): bigint {
  const s = human.toFixed(Math.min(decimals, 9));
  const [whole = "0", frac = ""] = s.split(".");
  const digits = whole + frac.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(digits);
}
```
1. `Math.min(decimals, 9)` caps `toFixed` at 9 fractional digits, silently replacing all digits after the 9th decimal place with `'0'`.
2. `toRaw(1e-10, 18)` returns `0n`.
3. `toRaw(1e21, 18)` outputs `"1e+21"` from `toFixed` and crashes with `SyntaxError: Cannot convert 1e+21000000000000000000 to a BigInt`.

## Evidence
```text
toRaw(0.123456789123456, 24) = 123456789000000000000000 (expected 123456789123456000000000)
toRaw(1e-10, 18)             = 0 (expected 100000000)
toRaw(1e21, 18) THREW: Cannot convert 1e+21000000000000000000 to a BigInt
```

## Environment
- Network: Somnia Tokyo / Hideki Testnet (`chainId 50383`)
- Package: `@dreamdex-bot-kit/perp-core@0.1.0`
- OS / Runtime: Linux x86_64, Node.js `v26.12.0`
