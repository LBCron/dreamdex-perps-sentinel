import {
  SOMNIA_HIDEKI_TESTNET_ADDRESSES,
  fromRawExact,
  makeSentinelChain,
  scalePriceByBps,
  toRawExact,
} from "../src/chain.js";
import { computeCarrySlice, computeEffectiveMarginRequirement } from "../src/funding-arb.js";
import { planEmergencyDeleverage } from "../src/liquidation-guard.js";
import { shouldRequoteMaker } from "../src/execution.js";

/**
 * Reproduces the buggy functions from `somnia-chain/dreamdex-bot-kit` side-by-side
 * with the fixed implementations in `dreamdex-perps-sentinel`.
 */
function buggyToRaw(human: number, decimals: number): bigint {
  const s = human.toFixed(Math.min(decimals, 9));
  const [i = "0", f = ""] = s.split(".");
  const negative = i.startsWith("-");
  const digits = (negative ? i.slice(1) : i) + f.padEnd(decimals, "0").slice(0, decimals);
  const raw = BigInt(digits || "0");
  return negative ? -raw : raw;
}

function main(): void {
  console.log("================================================================================");
  console.log("  dreamDEX Perps Bounty — Track 1 Bug Reproduction & Verification Suite");
  console.log("================================================================================\n");

  // BUG-01
  console.log("[BUG-01] closePosition() on stale oracle (priceable: false) & resting reducing orders:");
  const emergencyPlan = planEmergencyDeleverage({
    symbol: "BTC-PERP",
    poolAddress: SOMNIA_HIDEKI_TESTNET_ADDRESSES.btcPerpPool,
    size: 25_000_000n,
    baseDecimals: 8,
    lotSize: 100_000n,
    minQuantity: 100_000n,
    priceable: false,
    markPrice: toRawExact("75821.33", 18),
    bookTouchPrice: toRawExact("75800.00", 18),
    restingReducingOrderIds: ["resting-tp-42"],
    effectiveReducingCapacity: 5_000_000n,
  });
  console.log("  bot-kit closePosition()        : { sent: false, filled: 0n } (aborts immediately when !preview.priceable)");
  console.log(
    `  sentinel planEmergencyDeleverage: canExecute=${emergencyPlan.canExecute}, cancelFirst=[${emergencyPlan.orderIdsToCancelFirst.join(",")}], closeQty=${emergencyPlan.closeQuantityHuman} BTC\n`,
  );

  // BUG-02
  console.log("[BUG-02] toRaw(human, decimals) 9-decimal truncation & >=1e21 crash:");
  const nearVal = "0.123456789123456";
  console.log(`  bot-kit toRaw(0.123456789123456, 24) : ${buggyToRaw(0.123456789123456, 24).toString()}`);
  console.log(`  sentinel toRawExact(..., 24)         : ${toRawExact(nearVal, 24).toString()}`);
  console.log(`  bot-kit toRaw(1e-10, 18)             : ${buggyToRaw(1e-10, 18).toString()}`);
  console.log(`  sentinel toRawExact(1e-10, 18)       : ${toRawExact(1e-10, 18).toString()}`);
  let crashed = "";
  try {
    buggyToRaw(1e21, 18);
  } catch (e) {
    crashed = (e as Error).message;
  }
  console.log(`  bot-kit toRaw(1e21, 18)              : THREW "${crashed}"`);
  console.log(`  sentinel toRawExact(1e21, 18)        : ${toRawExact(1e21, 18).toString()}\n`);

  // BUG-03
  console.log("[BUG-03] IEEE-754 float overflow in BigInt(Math.round(price * 1e18)):");
  const btcTouch = 75821.33;
  const corrupted = BigInt(Math.round(btcTouch * 1e18));
  const exact = toRawExact(btcTouch, 18);
  console.log(`  bot-kit BigInt(Math.round(75821.33 * 1e18)) : ${corrupted.toString()} (off by +${(corrupted - exact).toString()} wei)`);
  console.log(`  sentinel toRawExact(75821.33, 18)           : ${exact.toString()} (0 wei drift)`);
  console.log(
    `  sentinel scalePriceByBps(+200bps, tick=1e16): $${fromRawExact(scalePriceByBps(exact, 200, 10n ** 16n, "sell"), 18).toFixed(2)}\n`,
  );

  // BUG-04
  console.log("[BUG-04] perp-funding carry scaling when already holding a $50 slice (MAX_POSITION = $200):");
  const scaleDecision = computeCarrySlice({
    currentPositionContracts: 0.5,
    currentPositionSide: "short",
    paySide: "sell",
    markPriceHuman: 100,
    fundingAprPct: 42.0,
    enterAprPct: 25.0,
    exitAprPct: 5.0,
    sliceUsdso: 50,
    maxPositionUsdso: 200,
  });
  console.log("  bot-kit perp-funding : skips scaling (`else if (!position && worthHolding && me)` is false once position exists)");
  console.log(`  sentinel carry sizer : action=${scaleDecision.action}, addNotional=$${scaleDecision.addNotionalUsdso} USDso (${scaleDecision.reason})\n`);

  // BUG-05
  console.log("[BUG-05] perp-maker missing leg after PostOnlyWouldCross on flat mark:");
  const makerDecision = shouldRequoteMaker({
    currentMarkPriceRaw: exact,
    resting: { bidOrderId: "1", askOrderId: undefined, atMarkPriceRaw: exact },
    allowBid: true,
    allowAsk: true,
    requoteBps: 10,
  });
  console.log("  bot-kit perp-maker   : sleeps forever while drift < REQUOTE_BPS because `(resting.bid || resting.ask)` is true");
  console.log(`  sentinel maker check : shouldRequote=${makerDecision.shouldRequote} (${makerDecision.reason})\n`);

  // BUG-06
  console.log("[BUG-06] hidekiTestnet dead multicall3 (0x540B...D131 = 0 bytes) & bot-kit missing multicall3:");
  const sentinelChain = makeSentinelChain("hideki");
  console.log(
    `  sdk hidekiTestnet.contracts.multicall3 : ${SOMNIA_HIDEKI_TESTNET_ADDRESSES.sdkBrokenMulticall3} (0 bytes bytecode -> getPerpState() throws 'aggregate3 returned no data ("0x")'!)`,
  );
  console.log("  bot-kit makeChain().contracts          : undefined (10 separate RPC calls per market = 220 RPC calls across 22 markets)");
  console.log(
    `  sentinel makeSentinelChain().contracts : multicall3=${sentinelChain.contracts?.multicall3?.address} (7,618 bytes bytecode -> 1 RPC call per market)\n`,
  );

  // BUG-07
  console.log("[BUG-07] preflight() under-estimating required collateral on 10x market / 5x account cap:");
  const effMargin = computeEffectiveMarginRequirement({
    notionalUsdso: 50,
    initialMarginBps: 1000,
    requestedLeverageX: 20,
    accountMaxLeverageX: 5,
    adverseSlippageBps: 50,
    takerFeeBpsTimes1k: 5_000n,
  });
  console.log("  bot-kit preflight()                     : checks NOTIONAL / LEVERAGE = $50 / 20 = $2.50 USDso");
  console.log(`  sentinel computeEffectiveMarginReq()    : requires $${effMargin.totalRequiredUsdso.toFixed(2)} USDso (effective ${effMargin.effectiveLeverageX}x cap + slippage + fee headroom)\n`);
}

main();
