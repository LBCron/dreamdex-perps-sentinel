# Bug Report 06: `hidekiTestnet` in `@somnia-chain/markets-sdk/chains` Hardcodes Dead `multicall3` Address (`0x540B...D131` Has `0` Bytecode on Chain `50383`), Crashing `getPerpState()` With `aggregate3 returned no data ("0x")`, While `perp-core` Omits `multicall3` Entirely

- **Severity**: Critical / Major
- **Area**: `sdk` / `bot-kit` (`@somnia-chain/markets-sdk/src/chains/definitions/hidekiTestnet.ts`, `@somnia-chain/markets-sdk/src/perp/state.ts`, `packages/perp-core/src/config.ts`)

## Steps to reproduce
1. Inspect `@somnia-chain/markets-sdk/src/chains/definitions/hidekiTestnet.ts` lines `22–26`:
   ```ts
   contracts: {
     multicall3: {
       address: "0x540B091b608f54E603c5dC19F6b2d955e1d2D131",
     },
   },
   ```
2. Inspect `@somnia-chain/markets-sdk/src/perp/state.ts` lines `185–237`:
   ```ts
   const canBatch = client.chain?.contracts?.multicall3?.address !== undefined;
   ```
   When `canBatch` is `true`, `getPerpState()` calls `client.multicall({ contracts, allowFailure: false })`.
3. Follow the official Perps Developer Quickstart (`https://app.testnet.dreamdex.io/docs/developers/perps-testnet`), which instructs developers to pass `chain: hidekiTestnet` into `new SomniaMarkets(...)`, and call `await exchange.client.getPerpState(pool)` on any Hideki perp pool (e.g., `BTC-PERP` `0x3b8aa132d05471e4c9268a4d66541fa4a2232023`).
4. Check the deployed bytecode on Somnia Hideki (`chainId 50383`, `https://api.hideki2.infra.testnet.somnia.network`):
   - `0x540B091b608f54E603c5dC19F6b2d955e1d2D131` (configured in `hidekiTestnet`): **0 bytes (`0x`)**
   - `0xcA11bde05977b3631167028862bE2a173976CA11` (canonical Multicall3 deployed on Hideki): **7,618 bytes**

## Expected
- `hidekiTestnet.contracts.multicall3.address` in `@somnia-chain/markets-sdk/chains` AND `makeChain()` in `@dreamdex-bot-kit/perp-core/src/config.ts` should both point to the canonical deployed Multicall3 contract on Hideki (`0xcA11bde05977b3631167028862bE2a173976CA11`), so `getPerpState()` succeeds in 1 batched RPC call per market instead of crashing or firing 10 unbatched RPC calls per market.

## Actual
1. In `@somnia-chain/markets-sdk`, passing `chain: hidekiTestnet` causes **every `getPerpState()` call to throw an unhandled `RpcError`**:
   ```text
   RpcError: @somnia-chain/markets-sdk: rpc multicall failed: The contract function "aggregate3" returned no data ("0x").
   ```
2. In `@dreamdex-bot-kit/perp-core/src/config.ts`, `makeChain()` omits `contracts.multicall3` entirely (`contracts: undefined`), which avoids the crash only by falling back to 10 separate `readContract` RPC calls per market (220 RPC calls across the 22 live perp markets).

## Evidence
```text
0x540B091b608f54E603c5dC19F6b2d955e1d2D131 bytecode length: 0
0xcA11bde05977b3631167028862bE2a173976CA11 bytecode length: 7618
RpcError: @somnia-chain/markets-sdk: rpc multicall failed: The contract function "aggregate3" returned no data ("0x").
```

## Environment
- Network: Somnia Tokyo / Hideki Testnet (`chainId 50383`)
- Packages: `@somnia-chain/markets-sdk@0.32.1`, `@dreamdex-bot-kit/perp-core@0.1.0`
- OS / Runtime: Linux x86_64, Node.js `v26.12.0`
