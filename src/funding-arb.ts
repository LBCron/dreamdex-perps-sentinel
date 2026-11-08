import { alignPrice, alignQuantity, divCeil, fromRawExact, toRawExact } from "./chain.js";

export type OrderSide = "buy" | "sell";

export interface PerpMarketSnapshot {
  symbol: string;
  poolAddress: `0x${string}`;
  marginBank: `0x${string}`;
  stopRegistry: `0x${string}`;
  baseDecimals: number;
  quoteDecimals: number;
  markPrice: bigint;
  indexPrice: bigint;
  tickSize: bigint;
  lotSize: bigint;
  minQuantity: bigint;
  initialMarginBps: number;
  effectiveImfBps: number;
  maintenanceMarginBps: number;
  fundingRate: bigint;
  fundingIntervalSec: number;
  takerFeeBpsTimes1k: bigint;
  makerFeeBpsTimes1k: bigint;
  openInterest: bigint;
  markUpdatedAtSec: number;
}

export interface CarryOpportunity {
  symbol: string;
  poolAddress: `0x${string}`;
  paySide: OrderSide;
  positionSide: "long" | "short";
  grossAprPct: number;
  instantPremiumAprPct: number;
  roundTripTakerFeePct: number;
  netAprPct: number;
  markPriceHuman: number;
  indexPriceHuman: number;
  maxMarketLeverageX: number;
  worthEntering: boolean;
}

export interface CarrySliceInput {
  currentPositionContracts: number;
  currentPositionSide?: "long" | "short";
  paySide: OrderSide;
  markPriceHuman: number;
  fundingAprPct: number;
  enterAprPct: number;
  exitAprPct: number;
  sliceUsdso: number;
  maxPositionUsdso: number;
}

export interface CarrySliceDecision {
  action: "enter" | "scale_in" | "hold" | "exit";
  side?: OrderSide;
  addNotionalUsdso: number;
  heldNotionalUsdso: number;
  reason: string;
}

export interface EffectiveMarginInput {
  notionalUsdso: number;
  initialMarginBps: number;
  effectiveImfBps?: number;
  requestedLeverageX: number;
  accountMaxLeverageX?: number;
  voucherActive?: boolean;
  voucherLeverageCapX?: number;
  adverseSlippageBps?: number;
  takerFeeBpsTimes1k?: bigint;
}

export interface EffectiveMarginResult {
  effectiveImfBps: number;
  appliedImBps: number;
  effectiveLeverageX: number;
  initialMarginUsdso: number;
  leverageSurchargeUsdso: number;
  adverseGapUsdso: number;
  feeHeadroomUsdso: number;
  totalRequiredUsdso: number;
}

export interface DeltaNeutralLeg {
  symbol: string;
  poolAddress: `0x${string}`;
  side: OrderSide;
  positionSide: "long" | "short";
  rawQuantity: bigint;
  humanQuantity: number;
  notionalUsdso: number;
  limitPriceRaw: bigint;
  expectedFundingAprPct: number;
}

export interface DeltaNeutralPairPlan {
  shortPerpLeg: DeltaNeutralLeg;
  longHedgeLeg: DeltaNeutralLeg;
  combinedGrossAprPct: number;
  combinedNetAprPct: number;
  totalNotionalUsdso: number;
  netDeltaUsdso: number;
}

const SECONDS_PER_YEAR = 365 * 24 * 3600;
const ONE_E18 = 10n ** 18n;

/**
 * Converts a 1e18-scaled signed funding rate over `fundingIntervalSec` into annualized percentage APR.
 * Positive rate: longs pay shorts (`paySide = "sell"`).
 * Negative rate: shorts pay longs (`paySide = "buy"`).
 */
export function fundingRateToAprPct(fundingRateRaw: bigint, fundingIntervalSec: number): number {
  if (fundingIntervalSec <= 0) return 0;
  const periodsPerYear = SECONDS_PER_YEAR / fundingIntervalSec;
  const perIntervalFraction = Number(fundingRateRaw) / 1e18;
  return Math.abs(perIntervalFraction) * periodsPerYear * 100;
}

/**
 * Returns the side that COLLECTS funding ("sell" = short when fundingRate > 0, "buy" = long when fundingRate < 0).
 */
export function fundingCollectingSide(fundingRateRaw: bigint): OrderSide | null {
  if (fundingRateRaw > 0n) return "sell";
  if (fundingRateRaw < 0n) return "buy";
  return null;
}

/**
 * Computes instantaneous mark-to-index premium in parts-per-million:
 * `floor((markPrice - indexPrice) * 1e6 / indexPrice)`.
 */
export function computeInstantPremiumPpm(markPrice: bigint, indexPrice: bigint): bigint {
  if (indexPrice <= 0n) return 0n;
  const diff = markPrice - indexPrice;
  const scaled = diff * 1_000_000n;
  const q = scaled / indexPrice;
  const r = scaled % indexPrice;
  return r < 0n ? q - 1n : q;
}

/**
 * Evaluates a market's funding carry opportunity net of round-trip taker fees (assuming a 7-day hold horizon).
 */
export function evaluateCarryOpportunity(
  market: PerpMarketSnapshot,
  enterAprPct = 20,
  holdDays = 7,
): CarryOpportunity {
  const grossAprPct = fundingRateToAprPct(market.fundingRate, market.fundingIntervalSec);
  const paySide = fundingCollectingSide(market.fundingRate) ?? "sell";
  const positionSide = paySide === "sell" ? "short" : "long";

  const premiumPpm = computeInstantPremiumPpm(market.markPrice, market.indexPrice);
  const intervalsPerDay = market.fundingIntervalSec > 0 ? 86400 / market.fundingIntervalSec : 3;
  const instantPremiumAprPct = (Math.abs(Number(premiumPpm)) / 1e6) * intervalsPerDay * 365 * 100;

  // Taker fee is in BPS_TIMES_1K (e.g. 5000 = 5 bps = 0.05%). Round-trip = 2x taker fee annualized over holdDays.
  const singleLegFeePct = (Number(market.takerFeeBpsTimes1k) / 1_000 / 10_000) * 100;
  const roundTripTakerFeePct = singleLegFeePct * 2 * (365 / Math.max(1, holdDays));
  const netAprPct = grossAprPct - roundTripTakerFeePct;

  const effectiveImf = Math.max(market.initialMarginBps, market.effectiveImfBps);
  const maxMarketLeverageX = effectiveImf > 0 ? Math.floor(10_000 / effectiveImf) : 1;

  return {
    symbol: market.symbol,
    poolAddress: market.poolAddress,
    paySide,
    positionSide,
    grossAprPct,
    instantPremiumAprPct,
    roundTripTakerFeePct,
    netAprPct,
    markPriceHuman: fromRawExact(market.markPrice, 18),
    indexPriceHuman: fromRawExact(market.indexPrice, 18),
    maxMarketLeverageX,
    worthEntering: grossAprPct >= enterAprPct && market.fundingRate !== 0n,
  };
}

/**
 * Decides whether to enter, scale in up to `maxPositionUsdso`, hold, or exit a funding carry position.
 *
 * Fixes BUG-04: In `strategies/perp-funding/src/index.ts:126`, the entry/scaling branch was gated by
 * `else if (!position && worthHolding && me)`, which meant `position` was always `undefined` inside the block,
 * `held` was always `0`, `if (held >= MAX_POSITION)` was unreachable dead code, and the bot could never scale
 * past its initial `NOTIONAL` slice up to `MAX_POSITION`.
 */
export function computeCarrySlice(input: CarrySliceInput): CarrySliceDecision {
  const hasPosition = input.currentPositionContracts > 0 && input.currentPositionSide !== undefined;
  const heldNotionalUsdso = hasPosition ? input.currentPositionContracts * input.markPriceHuman : 0;
  const desiredPositionSide = input.paySide === "sell" ? "short" : "long";

  if (hasPosition) {
    const signFlipped = input.currentPositionSide !== desiredPositionSide && input.fundingAprPct > 0;
    const rateSubsided = input.fundingAprPct < input.exitAprPct;
    if (signFlipped || rateSubsided) {
      return {
        action: "exit",
        side: input.currentPositionSide === "long" ? "sell" : "buy",
        addNotionalUsdso: 0,
        heldNotionalUsdso,
        reason: signFlipped
          ? `Funding sign flipped against ${input.currentPositionSide} position (now pays ${desiredPositionSide})`
          : `Funding APR ${input.fundingAprPct.toFixed(2)}% fell below exit threshold ${input.exitAprPct.toFixed(2)}%`,
      };
    }
  }

  const worthHolding = input.fundingAprPct >= input.enterAprPct;
  if (worthHolding && (!hasPosition || input.currentPositionSide === desiredPositionSide)) {
    const remainingCap = input.maxPositionUsdso - heldNotionalUsdso;
    // Allow tiny floating-point tolerance (1e-6 USDso)
    if (remainingCap <= 1e-6) {
      return {
        action: "hold",
        addNotionalUsdso: 0,
        heldNotionalUsdso,
        reason: `At max position cap ($${heldNotionalUsdso.toFixed(2)} / $${input.maxPositionUsdso.toFixed(2)} USDso)`,
      };
    }
    const addNotionalUsdso = Math.min(input.sliceUsdso, remainingCap);
    return {
      action: hasPosition ? "scale_in" : "enter",
      side: input.paySide,
      addNotionalUsdso,
      heldNotionalUsdso,
      reason: hasPosition
        ? `Scaling in +$${addNotionalUsdso.toFixed(2)} USDso (${heldNotionalUsdso.toFixed(2)} -> ${(heldNotionalUsdso + addNotionalUsdso).toFixed(2)} / $${input.maxPositionUsdso.toFixed(2)})`
        : `Entering initial $${addNotionalUsdso.toFixed(2)} USDso ${desiredPositionSide} carry slice at ${input.fundingAprPct.toFixed(2)}% APR`,
    };
  }

  return {
    action: "hold",
    addNotionalUsdso: 0,
    heldNotionalUsdso,
    reason: hasPosition
      ? `Holding ${input.currentPositionSide} ($${heldNotionalUsdso.toFixed(2)} USDso) — APR ${input.fundingAprPct.toFixed(2)}% between exit (${input.exitAprPct}%) and enter (${input.enterAprPct}%)`
      : `Flat — APR ${input.fundingAprPct.toFixed(2)}% below entry threshold ${input.enterAprPct}%`,
  };
}

/**
 * Computes exact collateral required for an order accounting for:
 * 1. Market's dynamic OI-scaled `effectiveImfBps` vs static `initialMarginBps`
 * 2. Account-level `setMaxLeverage` cap (`accountMaxLeverageX`) & credit-voucher cap (`voucherLeverageCapX`)
 * 3. Adverse mark-to-entry gap reserve (`adverseSlippageBps`)
 * 4. Taker fee headroom (`takerFeeBpsTimes1k`)
 *
 * Fixes BUG-07: `preflight()` in `@dreamdex-bot-kit/perp-core` checked only `NOTIONAL / LEVERAGE`,
 * severely under-estimating required collateral when `LEVERAGE` exceeded the market's max leverage
 * or when a stricter account/voucher leverage cap or adverse gap applied.
 */
export function computeEffectiveMarginRequirement(input: EffectiveMarginInput): EffectiveMarginResult {
  const effectiveImfBps = Math.max(input.initialMarginBps, input.effectiveImfBps ?? input.initialMarginBps);
  const marketMaxLeverageX = effectiveImfBps > 0 ? Math.floor(10_000 / effectiveImfBps) : 1;

  let effectiveLeverageX = Math.min(Math.max(1, input.requestedLeverageX), marketMaxLeverageX);
  if (input.accountMaxLeverageX && input.accountMaxLeverageX > 0) {
    effectiveLeverageX = Math.min(effectiveLeverageX, input.accountMaxLeverageX);
  }
  if (input.voucherActive && input.voucherLeverageCapX && input.voucherLeverageCapX > 0) {
    effectiveLeverageX = Math.min(effectiveLeverageX, input.voucherLeverageCapX);
  }

  const leverageImBps = Math.ceil(10_000 / effectiveLeverageX);
  const appliedImBps = Math.max(effectiveImfBps, leverageImBps);

  const initialMarginUsdso = (input.notionalUsdso * effectiveImfBps) / 10_000;
  const leverageSurchargeUsdso =
    appliedImBps > effectiveImfBps ? (input.notionalUsdso * (appliedImBps - effectiveImfBps)) / 10_000 : 0;
  const adverseGapUsdso = (input.notionalUsdso * Math.max(0, input.adverseSlippageBps ?? 0)) / 10_000;
  const feeRate = Number(input.takerFeeBpsTimes1k ?? 0n) / 10_000_000;
  const feeHeadroomUsdso = input.notionalUsdso * feeRate;

  const totalRequiredUsdso = initialMarginUsdso + leverageSurchargeUsdso + adverseGapUsdso + feeHeadroomUsdso;

  return {
    effectiveImfBps,
    appliedImBps,
    effectiveLeverageX,
    initialMarginUsdso,
    leverageSurchargeUsdso,
    adverseGapUsdso,
    feeHeadroomUsdso,
    totalRequiredUsdso,
  };
}

/**
 * Constructs a market-neutral (delta-neutral) two-leg pair across perp markets:
 * - Short the highest positive-funding market (or highest APR market)
 * - Long the most negative-funding market (or lowest-cost hedge market)
 * Both legs are quantized to their respective `lotSize` and `tickSize` grids.
 */
export function buildDeltaNeutralPair(
  shortMarket: PerpMarketSnapshot,
  longMarket: PerpMarketSnapshot,
  legNotionalUsdso: number,
  slippageBps = 25,
): DeltaNeutralPairPlan {
  const shortOneBase = 10n ** BigInt(shortMarket.baseDecimals);
  const longOneBase = 10n ** BigInt(longMarket.baseDecimals);
  const notionalRaw = toRawExact(legNotionalUsdso, 18);

  const rawShortWanted = (notionalRaw * shortOneBase) / shortMarket.markPrice;
  const rawShortQty = alignQuantity(rawShortWanted, shortMarket.lotSize);
  const rawShortPrice = alignPrice(
    (shortMarket.markPrice * BigInt(10_000 - slippageBps)) / 10_000n,
    shortMarket.tickSize,
    "sell",
  );
  const shortNotionalRaw = (rawShortQty * shortMarket.markPrice) / shortOneBase;
  const shortNotionalActual = fromRawExact(shortNotionalRaw, 18);

  // Match the hedge leg notional to the lot-quantized short leg notional to minimize residual delta
  const targetHedgeNotionalRaw = shortNotionalRaw > 0n ? shortNotionalRaw : notionalRaw;
  const rawLongWanted = (targetHedgeNotionalRaw * longOneBase) / longMarket.markPrice;
  const rawLongQty = alignQuantity(rawLongWanted, longMarket.lotSize);
  const rawLongPrice = alignPrice(
    divCeil(longMarket.markPrice * BigInt(10_000 + slippageBps), 10_000n),
    longMarket.tickSize,
    "buy",
  );
  const longNotionalActual = fromRawExact((rawLongQty * longMarket.markPrice) / longOneBase, 18);

  // Short leg collects positive fundingRate; Long leg collects negative fundingRate (or pays positive fundingRate).
  const shortLegSignedApr =
    (Number(shortMarket.fundingRate) / 1e18) * (SECONDS_PER_YEAR / shortMarket.fundingIntervalSec) * 100;
  const longLegSignedApr =
    (-Number(longMarket.fundingRate) / 1e18) * (SECONDS_PER_YEAR / longMarket.fundingIntervalSec) * 100;

  // Portfolio yield on total deployed notional (2 legs)
  const combinedGrossAprPct = (shortLegSignedApr + longLegSignedApr) / 2;
  const shortFeePct = (Number(shortMarket.takerFeeBpsTimes1k) / 10_000_000) * 100 * 2 * (365 / 7);
  const longFeePct = (Number(longMarket.takerFeeBpsTimes1k) / 10_000_000) * 100 * 2 * (365 / 7);
  const combinedNetAprPct = combinedGrossAprPct - (shortFeePct + longFeePct) / 2;

  return {
    shortPerpLeg: {
      symbol: shortMarket.symbol,
      poolAddress: shortMarket.poolAddress,
      side: "sell",
      positionSide: "short",
      rawQuantity: rawShortQty,
      humanQuantity: fromRawExact(rawShortQty, shortMarket.baseDecimals),
      notionalUsdso: shortNotionalActual,
      limitPriceRaw: rawShortPrice,
      expectedFundingAprPct: shortLegSignedApr,
    },
    longHedgeLeg: {
      symbol: longMarket.symbol,
      poolAddress: longMarket.poolAddress,
      side: "buy",
      positionSide: "long",
      rawQuantity: rawLongQty,
      humanQuantity: fromRawExact(rawLongQty, longMarket.baseDecimals),
      notionalUsdso: longNotionalActual,
      limitPriceRaw: rawLongPrice,
      expectedFundingAprPct: longLegSignedApr,
    },
    combinedGrossAprPct,
    combinedNetAprPct,
    totalNotionalUsdso: shortNotionalActual + longNotionalActual,
    netDeltaUsdso: longNotionalActual - shortNotionalActual,
  };
}
