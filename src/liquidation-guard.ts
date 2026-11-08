import { alignPrice, alignQuantity, divCeil, fromRawExact, scalePriceByBps } from "./chain.js";
import type { OrderSide } from "./funding-arb.js";

export type HealthStage = "HEALTHY" | "WATCH" | "SCALE_DOWN" | "EMERGENCY_FLATTEN";

export interface LiquidationPriceInput {
  equity: bigint;
  mmReq: bigint;
  size: bigint;
  markPrice: bigint;
  maintenanceMarginBps: bigint;
  oneBase: bigint;
}

export interface PositionCloseState {
  symbol: string;
  poolAddress: `0x${string}`;
  /** Signed position size in raw base units (positive = long, negative = short). */
  size: bigint;
  baseDecimals: number;
  lotSize: bigint;
  minQuantity: bigint;
  /** Whether the oracle mark feed is fresh (`tryGetHealthSnapshot` ok = true). */
  priceable: boolean;
  /** Live or last-known mark price in 1e18 quote units. */
  markPrice: bigint;
  /** Best bid/ask touch price from the resting order book in 1e18 quote units (0n if empty). */
  bookTouchPrice: bigint;
  /** Quantity of open resting orders on the reducing side already speaking for `_reducingCapacity`. */
  restingReducingOrderIds: string[];
  effectiveReducingCapacity: bigint;
}

export interface EmergencyDeleveragePlan {
  symbol: string;
  poolAddress: `0x${string}`;
  canExecute: boolean;
  usedStaleOracleFallback: boolean;
  orderIdsToCancelFirst: string[];
  closeSide: OrderSide;
  closeQuantityRaw: bigint;
  closeQuantityHuman: number;
  worstFillPriceRaw: bigint;
  remainingDustRaw: bigint;
  reason: string;
}

const BPS_DENOMINATOR = 10_000n;

function absBigInt(x: bigint): bigint {
  return x < 0n ? -x : x;
}

/**
 * Exact BigInt port of `@somnia-chain/markets-sdk` `perpLiquidationPrice`, solving for the mark price
 * `P_liq` where `equity(P_liq) == mmReq(P_liq)` while accounting for the moving maintenance requirement
 * (`10000 - mmBps` for longs, `10000 + mmBps` for shorts).
 */
export function computePerpLiquidationPrice(input: LiquidationPriceInput): bigint | null {
  const { equity, mmReq, size, markPrice, maintenanceMarginBps, oneBase } = input;
  if (size === 0n || oneBase <= 0n) return null;

  const isLong = size > 0n;
  const absSize = absBigInt(size);
  const buffer = equity - mmReq;

  const factor = isLong
    ? BPS_DENOMINATOR - maintenanceMarginBps
    : BPS_DENOMINATOR + maintenanceMarginBps;
  if (factor <= 0n) return 0n;

  const denom = absSize * factor;
  const num = buffer * oneBase * BPS_DENOMINATOR;

  // Floor the signed move so long liq rounds UP and short liq rounds DOWN (conservative).
  let deltaPrice: bigint;
  if (num >= 0n) {
    deltaPrice = num / denom;
  } else {
    deltaPrice = -((-num + denom - 1n) / denom);
  }

  const rawLiq = isLong ? markPrice - deltaPrice : markPrice + deltaPrice;
  return rawLiq > 0n ? rawLiq : 0n;
}

/**
 * Computes cross-margin account health ratio `equity / mmReq`.
 * Returns `Infinity` when `mmReq <= 0n` (no open positions).
 */
export function computeAccountHealthRatio(equity: bigint, mmReq: bigint): number {
  if (mmReq <= 0n) return Number.POSITIVE_INFINITY;
  return Number(equity) / Number(mmReq);
}

/**
 * Classifies account health into actionable risk stages for `perp-guard`.
 */
export function classifyHealthAction(
  equity: bigint,
  mmReq: bigint,
  opts: {
    warnRatio?: number;
    emergencyRatio?: number;
    oracleAgeSec?: number;
    maxOracleAgeSec?: number;
  } = {},
): { stage: HealthStage; healthRatio: number; reason: string } {
  const warnRatio = opts.warnRatio ?? 1.5;
  const emergencyRatio = opts.emergencyRatio ?? 1.2;
  const maxOracleAgeSec = opts.maxOracleAgeSec ?? 120;
  const healthRatio = computeAccountHealthRatio(equity, mmReq);

  if (opts.oracleAgeSec !== undefined && opts.oracleAgeSec > maxOracleAgeSec && mmReq > 0n) {
    return {
      stage: "EMERGENCY_FLATTEN",
      healthRatio,
      reason: `Oracle mark stale (${opts.oracleAgeSec}s > ${maxOracleAgeSec}s) with active exposure — emergency reduce required`,
    };
  }
  if (!Number.isFinite(healthRatio)) {
    return { stage: "HEALTHY", healthRatio, reason: "No active maintenance margin requirement (flat)" };
  }
  if (healthRatio <= emergencyRatio) {
    return {
      stage: "EMERGENCY_FLATTEN",
      healthRatio,
      reason: `Health ratio ${healthRatio.toFixed(2)}x <= emergency threshold ${emergencyRatio.toFixed(2)}x — flattening all positions`,
    };
  }
  if (healthRatio <= warnRatio) {
    return {
      stage: "SCALE_DOWN",
      healthRatio,
      reason: `Health ratio ${healthRatio.toFixed(2)}x <= warn threshold ${warnRatio.toFixed(2)}x — scaling down 50%`,
    };
  }
  if (healthRatio <= warnRatio * 1.25) {
    return {
      stage: "WATCH",
      healthRatio,
      reason: `Health ratio ${healthRatio.toFixed(2)}x in watch zone`,
    };
  }
  return {
    stage: "HEALTHY",
    healthRatio,
    reason: `Health ratio ${healthRatio.toFixed(2)}x healthy`,
  };
}

/**
 * Plans a safe emergency close or partial scale-down for a perpetual position.
 *
 * Fixes BUG-01 in `@dreamdex-bot-kit/perp-core` (`closePosition` in `packages/perp-core/src/orders.ts`):
 * 1. **Stale Oracle Fallback (`priceable: false`)**: `closePosition()` previously called `previewPerpClosePnl`
 *    and immediately aborted (`if (!preview.priceable) return { sent: false, filled: 0n }`), making `perp-guard`
 *    incapable of closing positions during an oracle outage even though `PerpPool` explicitly keeps reducing
 *    orders open on stale marks. Here, when `!state.priceable`, we read `size` directly from `MarginBank.getPosition`
 *    and price the reduce order off `bookTouchPrice` (or last known `markPrice`).
 * 2. **Resting Reducing Order Cancellation**: `PerpPool._computeLockAmount` subtracts resting reducing orders from
 *    `_reducingCapacity`. Sending a full market close while a TP/maker order rests on the reducing side causes the
 *    overlap to be treated as an **increasing** leg (`increasingQuantity > 0`), which reverts `InsufficientMarginForOrder`
 *    during `MarginCall`. We explicitly schedule `restingReducingOrderIds` for cancellation first (or clamp to
 *    `effectiveReducingCapacity` if cancellation is skipped).
 * 3. **Exact BigInt Slippage & Tick Alignment**: Uses `scalePriceByBps` instead of `BigInt(Math.round(touch * 1e18))`.
 */
export function planEmergencyDeleverage(
  state: PositionCloseState,
  opts: {
    fractionToClose?: number;
    slippageBps?: number;
    cancelRestingOrdersFirst?: boolean;
  } = {},
): EmergencyDeleveragePlan {
  const absSize = absBigInt(state.size);
  const closeSide: OrderSide = state.size > 0n ? "sell" : "buy";
  const lotSize = state.lotSize > 0n ? state.lotSize : 1n;

  if (absSize === 0n) {
    return {
      symbol: state.symbol,
      poolAddress: state.poolAddress,
      canExecute: false,
      usedStaleOracleFallback: !state.priceable,
      orderIdsToCancelFirst: [],
      closeSide,
      closeQuantityRaw: 0n,
      closeQuantityHuman: 0,
      worstFillPriceRaw: 0n,
      remainingDustRaw: 0n,
      reason: "Position is already flat (size = 0)",
    };
  }

  const cancelFirst = opts.cancelRestingOrdersFirst ?? true;
  const orderIdsToCancelFirst = cancelFirst ? [...state.restingReducingOrderIds] : [];

  // If we cancel resting reducing orders first, full |size| is available as reducing capacity.
  // Otherwise we must clamp to effectiveReducingCapacity so we never trigger an increasing-leg margin lock!
  const availableReducingCapacity = cancelFirst ? absSize : state.effectiveReducingCapacity;

  const fractionBps = BigInt(Math.round(Math.min(1, Math.max(0.01, opts.fractionToClose ?? 1.0)) * 10_000));
  const desiredRaw = divCeil(absSize * fractionBps, BPS_DENOMINATOR);
  const clampedRaw = desiredRaw > availableReducingCapacity ? availableReducingCapacity : desiredRaw;
  const alignedQty = alignQuantity(clampedRaw, lotSize);

  const referencePrice = state.bookTouchPrice > 0n ? state.bookTouchPrice : state.markPrice;
  if (referencePrice <= 0n || alignedQty < state.minQuantity || alignedQty <= 0n) {
    return {
      symbol: state.symbol,
      poolAddress: state.poolAddress,
      canExecute: false,
      usedStaleOracleFallback: !state.priceable,
      orderIdsToCancelFirst,
      closeSide,
      closeQuantityRaw: alignedQty,
      closeQuantityHuman: fromRawExact(alignedQty, state.baseDecimals),
      worstFillPriceRaw: 0n,
      remainingDustRaw: absSize,
      reason:
        referencePrice <= 0n
          ? "No reference price available from either order book or mark feed"
          : `Aligned close quantity ${alignedQty} is below pool minQuantity ${state.minQuantity}`,
    };
  }

  const slipBps = opts.slippageBps ?? 150;
  const signedSlipBps = closeSide === "buy" ? slipBps : -slipBps;
  const worstFillPriceRaw = scalePriceByBps(referencePrice, signedSlipBps, 1n, closeSide);
  const remainingDustRaw = absSize - alignedQty;

  return {
    symbol: state.symbol,
    poolAddress: state.poolAddress,
    canExecute: true,
    usedStaleOracleFallback: !state.priceable,
    orderIdsToCancelFirst,
    closeSide,
    closeQuantityRaw: alignedQty,
    closeQuantityHuman: fromRawExact(alignedQty, state.baseDecimals),
    worstFillPriceRaw,
    remainingDustRaw,
    reason: !state.priceable
      ? `Emergency stale-oracle close via direct MarginBank position read (${orderIdsToCancelFirst.length} resting orders cancelled first)`
      : `Standard risk-managed close (${orderIdsToCancelFirst.length} resting orders cancelled first)`,
  };
}
