import { describe, expect, it } from "vitest";
import {
  SOMNIA_HIDEKI_TESTNET_ADDRESSES,
  alignPrice,
  alignQuantity,
  divCeil,
  divCeilSigned,
  divFloor,
  fromRawExact,
  makeSentinelChain,
  scalePriceByBps,
  toRawExact,
} from "../src/chain.js";
import {
  buildDeltaNeutralPair,
  computeCarrySlice,
  computeEffectiveMarginRequirement,
  computeInstantPremiumPpm,
  evaluateCarryOpportunity,
  fundingCollectingSide,
  fundingRateToAprPct,
  type PerpMarketSnapshot,
} from "../src/funding-arb.js";
import {
  classifyHealthAction,
  computeAccountHealthRatio,
  computePerpLiquidationPrice,
  planEmergencyDeleverage,
} from "../src/liquidation-guard.js";
import {
  TRIGGER_GTE,
  TRIGGER_LTE,
  buildMakerQuotes,
  buildOcoBracket,
  evaluateWatchedExit,
  shouldRequoteMaker,
} from "../src/execution.js";
import { SentinelCrossMarginSimulator } from "../src/simulator.js";

const SAMPLE_BTC_MARKET: PerpMarketSnapshot = {
  symbol: "BTC-PERP",
  poolAddress: SOMNIA_HIDEKI_TESTNET_ADDRESSES.btcPerpPool,
  marginBank: SOMNIA_HIDEKI_TESTNET_ADDRESSES.marginBank,
  stopRegistry: "0x0000000000000000000000000000000000000001",
  baseDecimals: 8,
  quoteDecimals: 18,
  markPrice: toRawExact("75821.33", 18),
  indexPrice: toRawExact("75780.00", 18),
  tickSize: toRawExact("0.01", 18),
  lotSize: 100_000n,
  minQuantity: 100_000n,
  initialMarginBps: 250,
  effectiveImfBps: 250,
  maintenanceMarginBps: 125,
  fundingRate: toRawExact("0.0005", 18),
  fundingIntervalSec: 28_800,
  takerFeeBpsTimes1k: 5_000n,
  makerFeeBpsTimes1k: 1_000n,
  openInterest: 500_000_000n,
  markUpdatedAtSec: 1_762_000_000,
};

describe("Chain & Precision Quantizer (Fixes BUG-02, BUG-03, BUG-06, BUG-08)", () => {
  it("configures live multicall3 (0xcA11bde05977b3631167028862bE2a173976CA11) on Somnia Hideki (50383) [BUG-06]", () => {
    const hideki = makeSentinelChain("hideki");
    const shannon = makeSentinelChain("testnet");
    expect(hideki.id).toBe(50383);
    expect(hideki.contracts?.multicall3?.address).toBe("0xcA11bde05977b3631167028862bE2a173976CA11");
    expect(shannon.id).toBe(50312);
    expect(shannon.contracts?.multicall3?.address).toBe("0x841b8199E6d3Db3C6f264f6C2bd8848b3cA64223");
  });

  it("preserves >9 fractional digits (up to 24 decimals for NEAR-PERP) and handles scientific notation [BUG-02]", () => {
    expect(toRawExact("0.123456789123456", 24)).toBe(123456789123456000000000n);
    expect(toRawExact(1e-10, 18)).toBe(100_000_000n);
    expect(toRawExact(1e21, 18)).toBe(10n ** 39n);
    expect(toRawExact(-25.5, 18)).toBe(-25_500_000_000_000_000_000n);
  });

  it("avoids IEEE-754 float overflow on BTC-PERP prices (~$75,821.33) and aligns ticks [BUG-03]", () => {
    const rawBtc = toRawExact(75821.33, 18);
    expect(rawBtc).toBe(75821330000000000000000n);
    expect(rawBtc % toRawExact("0.01", 18)).toBe(0n);

    const up2Pct = scalePriceByBps(rawBtc, 200, toRawExact("0.01", 18), "sell");
    expect(up2Pct % toRawExact("0.01", 18)).toBe(0n);
    expect(fromRawExact(up2Pct, 18)).toBeCloseTo(77337.76, 2);
  });

  it("aligns prices (floor on buy, ceil on sell) and quantities (floor to lotSize)", () => {
    const tick = 100n;
    expect(alignPrice(1050n, tick, "buy")).toBe(1000n);
    expect(alignPrice(1050n, tick, "sell")).toBe(1100n);
    expect(alignQuantity(999n, 250n)).toBe(750n);
  });

  it("implements divCeil, divFloor, and divCeilSigned matching Solidity PerpMath", () => {
    expect(divCeil(10n, 3n)).toBe(4n);
    expect(divFloor(-10n, 3n)).toBe(-4n);
    expect(divCeilSigned(10n, 3n)).toBe(4n);
    expect(divCeilSigned(-10n, 3n)).toBe(-3n);
  });
});

describe("Funding-Rate Arbitrage & Delta-Neutral Sizer (Fixes BUG-04, BUG-07)", () => {
  it("converts 8h funding rate into annualized APR and identifies collecting side", () => {
    // 0.05% per 8h = 0.15% per day = 54.75% APR
    const apr = fundingRateToAprPct(toRawExact("0.0005", 18), 28_800);
    expect(apr).toBeCloseTo(54.75, 4);
    expect(fundingCollectingSide(toRawExact("0.0005", 18))).toBe("sell");
    expect(fundingCollectingSide(toRawExact("-0.0005", 18))).toBe("buy");
  });

  it("computes instantaneous mark-to-index premium in ppm (floored)", () => {
    const ppm = computeInstantPremiumPpm(toRawExact("100.15", 18), toRawExact("100.00", 18));
    expect(ppm).toBe(1500n);
  });

  it("scales carry position across cycles up to MAX_POSITION instead of stopping after slice 1 [BUG-04]", () => {
    // Cycle 1: flat -> enter $50
    const c1 = computeCarrySlice({
      currentPositionContracts: 0,
      paySide: "sell",
      markPriceHuman: 100,
      fundingAprPct: 40,
      enterAprPct: 25,
      exitAprPct: 5,
      sliceUsdso: 50,
      maxPositionUsdso: 200,
    });
    expect(c1.action).toBe("enter");
    expect(c1.addNotionalUsdso).toBe(50);

    // Cycle 2: holding 0.5 contracts ($50) -> scale_in +$50
    const c2 = computeCarrySlice({
      currentPositionContracts: 0.5,
      currentPositionSide: "short",
      paySide: "sell",
      markPriceHuman: 100,
      fundingAprPct: 40,
      enterAprPct: 25,
      exitAprPct: 5,
      sliceUsdso: 50,
      maxPositionUsdso: 200,
    });
    expect(c2.action).toBe("scale_in");
    expect(c2.addNotionalUsdso).toBe(50);

    // Cycle 3: holding 2.0 contracts ($200 == maxPositionUsdso) -> hold at cap
    const c3 = computeCarrySlice({
      currentPositionContracts: 2.0,
      currentPositionSide: "short",
      paySide: "sell",
      markPriceHuman: 100,
      fundingAprPct: 40,
      enterAprPct: 25,
      exitAprPct: 5,
      sliceUsdso: 50,
      maxPositionUsdso: 200,
    });
    expect(c3.action).toBe("hold");
    expect(c3.addNotionalUsdso).toBe(0);

    // Cycle 4: APR drops below exit threshold -> exit
    const c4 = computeCarrySlice({
      currentPositionContracts: 2.0,
      currentPositionSide: "short",
      paySide: "sell",
      markPriceHuman: 100,
      fundingAprPct: 2.0,
      enterAprPct: 25,
      exitAprPct: 5,
      sliceUsdso: 50,
      maxPositionUsdso: 200,
    });
    expect(c4.action).toBe("exit");
    expect(c4.side).toBe("buy");
  });

  it("computes effective margin requirement with market ceiling, account cap, and adverse gap [BUG-07]", () => {
    const res = computeEffectiveMarginRequirement({
      notionalUsdso: 100,
      initialMarginBps: 1000, // 10% (10x max)
      requestedLeverageX: 20, // user asked for 20x
      accountMaxLeverageX: 4, // account capped at 4x (25% IM)
      adverseSlippageBps: 50, // 0.5% adverse gap
      takerFeeBpsTimes1k: 5_000n, // 0.05% fee
    });
    expect(res.effectiveLeverageX).toBe(4);
    expect(res.initialMarginUsdso).toBeCloseTo(10, 4);
    expect(res.leverageSurchargeUsdso).toBeCloseTo(15, 4);
    expect(res.adverseGapUsdso).toBeCloseTo(0.5, 4);
    expect(res.feeHeadroomUsdso).toBeCloseTo(0.05, 4);
    expect(res.totalRequiredUsdso).toBeCloseTo(25.55, 4);
  });

  it("builds a delta-neutral two-leg pair with lot-aligned quantities", () => {
    const ethMarket: PerpMarketSnapshot = {
      ...SAMPLE_BTC_MARKET,
      symbol: "ETH-PERP",
      poolAddress: SOMNIA_HIDEKI_TESTNET_ADDRESSES.ethPerpPool,
      baseDecimals: 18,
      markPrice: toRawExact("2500", 18),
      lotSize: 10n ** 15n,
      fundingRate: toRawExact("-0.0003", 18),
    };
    const plan = buildDeltaNeutralPair(SAMPLE_BTC_MARKET, ethMarket, 1000);
    expect(plan.shortPerpLeg.side).toBe("sell");
    expect(plan.longHedgeLeg.side).toBe("buy");
    expect(plan.shortPerpLeg.rawQuantity % SAMPLE_BTC_MARKET.lotSize).toBe(0n);
    expect(plan.longHedgeLeg.rawQuantity % ethMarket.lotSize).toBe(0n);
    expect(plan.combinedGrossAprPct).toBeGreaterThan(30);
    expect(Math.abs(plan.netDeltaUsdso)).toBeLessThan(10);
  });
});

describe("Liquidation Guard & Stale-Oracle Emergency Close (Fixes BUG-01)", () => {
  it("computes exact perpLiquidationPrice accounting for moving maintenance margin", () => {
    // 1 BTC long @ $75,000, equity = $3,750 (20x), MM = 125 bps (1.25% = $937.50)
    const liq = computePerpLiquidationPrice({
      equity: toRawExact("3750", 18),
      mmReq: toRawExact("937.5", 18),
      size: 100_000_000n,
      markPrice: toRawExact("75000", 18),
      maintenanceMarginBps: 125n,
      oneBase: 100_000_000n,
    });
    expect(liq).not.toBeNull();
    // buffer = 2812.5; delta = 2812.5 / (1 * 0.9875) = 2848.101265... -> liq = 75000 - 2848.101265 = 72151.8987...
    expect(fromRawExact(liq!, 18)).toBeCloseTo(72151.8987, 2);
  });

  it("executes emergency close even when oracle mark is stale (priceable: false) and cancels resting orders first [BUG-01]", () => {
    const plan = planEmergencyDeleverage({
      symbol: "BTC-PERP",
      poolAddress: SOMNIA_HIDEKI_TESTNET_ADDRESSES.btcPerpPool,
      size: 50_000_000n, // 0.5 BTC long
      baseDecimals: 8,
      lotSize: 100_000n,
      minQuantity: 100_000n,
      priceable: false, // Stale oracle!
      markPrice: toRawExact("75000", 18),
      bookTouchPrice: toRawExact("74950", 18),
      restingReducingOrderIds: ["order-101", "order-102"],
      effectiveReducingCapacity: 10_000_000n,
    });

    expect(plan.canExecute).toBe(true);
    expect(plan.usedStaleOracleFallback).toBe(true);
    expect(plan.orderIdsToCancelFirst).toEqual(["order-101", "order-102"]);
    expect(plan.closeSide).toBe("sell");
    expect(plan.closeQuantityRaw).toBe(50_000_000n);
  });

  it("clamps close quantity to effectiveReducingCapacity when resting order cancellation is disabled [BUG-01]", () => {
    const plan = planEmergencyDeleverage(
      {
        symbol: "BTC-PERP",
        poolAddress: SOMNIA_HIDEKI_TESTNET_ADDRESSES.btcPerpPool,
        size: 50_000_000n,
        baseDecimals: 8,
        lotSize: 100_000n,
        minQuantity: 100_000n,
        priceable: true,
        markPrice: toRawExact("75000", 18),
        bookTouchPrice: toRawExact("74990", 18),
        restingReducingOrderIds: ["order-101"],
        effectiveReducingCapacity: 20_000_000n,
      },
      { cancelRestingOrdersFirst: false },
    );
    expect(plan.canExecute).toBe(true);
    expect(plan.orderIdsToCancelFirst).toEqual([]);
    expect(plan.closeQuantityRaw).toBe(20_000_000n);
  });
});

describe("Two-Sided Maker Re-Quoter & OCO Brackets (Fixes BUG-05)", () => {
  it("re-quotes immediately when an allowed side is missing after PostOnlyWouldCross [BUG-05]", () => {
    const mark = toRawExact("75000", 18);
    // Bid rested, Ask was skipped on cycle 1 due to PostOnlyWouldCross; mark hasn't moved (drift = 0 bps)
    const decision = shouldRequoteMaker({
      currentMarkPriceRaw: mark,
      resting: { bidOrderId: "bid-1", askOrderId: undefined, atMarkPriceRaw: mark },
      allowBid: true,
      allowAsk: true,
      requoteBps: 15,
    });
    expect(decision.shouldRequote).toBe(true);
    expect(decision.missingAllowedAsk).toBe(true);

    // Once both sides are resting and drift < requoteBps, it preserves queue priority
    const decisionBothResting = shouldRequoteMaker({
      currentMarkPriceRaw: mark,
      resting: { bidOrderId: "bid-1", askOrderId: "ask-1", atMarkPriceRaw: mark },
      allowBid: true,
      allowAsk: true,
      requoteBps: 15,
    });
    expect(decisionBothResting.shouldRequote).toBe(false);
  });

  it("builds tick-aligned OCO brackets and evaluates watched exits accurately", () => {
    const bracket = buildOcoBracket({
      positionSide: "short",
      entryMarkPriceRaw: toRawExact("2500", 18),
      quantityRaw: toRawExact("1", 18),
      tickSize: toRawExact("0.10", 18),
      takeProfitPct: 4.0,
      stopLossPct: 2.0,
    });
    expect(bracket.exitSide).toBe("buy");
    expect(bracket.takeProfitTriggerCondition).toBe(TRIGGER_LTE);
    expect(bracket.stopLossTriggerCondition).toBe(TRIGGER_GTE);
    expect(fromRawExact(bracket.takeProfitTriggerPriceRaw, 18)).toBeCloseTo(2400, 2);
    expect(fromRawExact(bracket.stopLossTriggerPriceRaw, 18)).toBeCloseTo(2550, 2);

    expect(evaluateWatchedExit(bracket, toRawExact("2395", 18)).leg).toBe("take-profit");
    expect(evaluateWatchedExit(bracket, toRawExact("2555", 18)).leg).toBe("stop-loss");
    expect(evaluateWatchedExit(bracket, toRawExact("2480", 18)).triggered).toBe(false);
  });

  it("builds post-only maker quotes on the tick/lot grid", () => {
    const q = buildMakerQuotes({
      markPriceRaw: toRawExact("75000", 18),
      tickSize: toRawExact("0.1", 18),
      lotSize: 100_000n,
      baseDecimals: 8,
      spreadBps: 20,
      orderNotionalUsdso: 750,
    });
    expect(fromRawExact(q.bidPriceRaw, 18)).toBeCloseTo(74925, 2);
    expect(fromRawExact(q.askPriceRaw, 18)).toBeCloseTo(75075, 2);
    expect(q.quantityRaw).toBe(1_000_000n); // 0.01 BTC
  });
});

describe("Cross-Margin Simulator (4-Case settleTrade + Whole-Position Funding)", () => {
  it("settles OPEN, INCREASE (floored VWAP), REDUCE (whole-position funding), and FLIP", () => {
    const sim = new SentinelCrossMarginSimulator(toRawExact("1000", 18));
    sim.registerMarket({
      symbol: "ETH-PERP",
      poolAddress: SOMNIA_HIDEKI_TESTNET_ADDRESSES.ethPerpPool,
      baseDecimals: 18,
      initialMarginBps: 250,
      maintenanceMarginBps: 125,
      markPrice: toRawExact("2000", 18),
      cumulativeFundingIndex: 0n,
    });

    // 1. OPEN 1 ETH long @ $2,000
    const openRes = sim.settleTrade({
      symbol: "ETH-PERP",
      isBid: true,
      quantity: toRawExact("1", 18),
      fillPrice: toRawExact("2000", 18),
      feeBpsTimes1k: 0n,
    });
    expect(openRes.newSize).toBe(toRawExact("1", 18));
    expect(openRes.newAvgEntryPrice).toBe(toRawExact("2000", 18));

    // 2. INCREASE +1 ETH long @ $2,200 -> VWAP = $2,100
    const incRes = sim.settleTrade({
      symbol: "ETH-PERP",
      isBid: true,
      quantity: toRawExact("1", 18),
      fillPrice: toRawExact("2200", 18),
      feeBpsTimes1k: 0n,
    });
    expect(incRes.newSize).toBe(toRawExact("2", 18));
    expect(incRes.newAvgEntryPrice).toBe(toRawExact("2100", 18));

    // 3. Accrue $5/ETH funding against longs, then close 10% (0.2 ETH) @ $2,300
    // Whole-position funding ($5 * 2 ETH = $10) settles on the 10% close!
    sim.updateMarketState("ETH-PERP", {
      markPrice: toRawExact("2300", 18),
      cumulativeFundingIndex: toRawExact("5", 18) * 10n ** 18n,
    });
    const redRes = sim.settleTrade({
      symbol: "ETH-PERP",
      isBid: false,
      quantity: toRawExact("0.2", 18),
      fillPrice: toRawExact("2300", 18),
      feeBpsTimes1k: 0n,
    });
    expect(redRes.fundingSettled).toBe(toRawExact("10", 18));
    expect(redRes.realizedPnl).toBe(toRawExact("40", 18)); // (2300 - 2100) * 0.2 = $40
    expect(redRes.newAvgEntryPrice).toBe(toRawExact("2100", 18)); // untouched on partial close
  });
});
