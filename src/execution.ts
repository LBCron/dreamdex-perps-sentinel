import { alignPrice, alignQuantity, scalePriceByBps, toRawExact } from "./chain.js";
import type { OrderSide } from "./funding-arb.js";

export const TRIGGER_GTE = 0 as const;
export const TRIGGER_LTE = 1 as const;

export interface RestingMakerState {
  bidOrderId?: string;
  askOrderId?: string;
  atMarkPriceRaw?: bigint;
}

export interface MakerRequoteCheckInput {
  currentMarkPriceRaw: bigint;
  resting: RestingMakerState;
  allowBid: boolean;
  allowAsk: boolean;
  requoteBps: number;
}

export interface MakerRequoteDecision {
  shouldRequote: boolean;
  missingAllowedBid: boolean;
  missingAllowedAsk: boolean;
  driftBps: number;
  reason: string;
}

export interface OcoBracketPlan {
  positionSide: "long" | "short";
  exitSide: OrderSide;
  quantityRaw: bigint;
  takeProfitTriggerPriceRaw: bigint;
  takeProfitTriggerCondition: typeof TRIGGER_GTE | typeof TRIGGER_LTE;
  stopLossTriggerPriceRaw: bigint;
  stopLossTriggerCondition: typeof TRIGGER_GTE | typeof TRIGGER_LTE;
}

/**
 * Determines whether a two-sided market maker (`perp-maker`) should cancel & replace its quotes.
 *
 * Fixes BUG-05: `strategies/perp-maker/src/index.ts:124` checked:
 * `if (drift < REQUOTE_BPS / 10_000 && (resting.bid || resting.ask))`
 * When one side was skipped on cycle 1 due to `PostOnlyWouldCross` (or temporary inventory cap),
 * the other side set `resting.atMark = mark` and `resting.bid` (or `resting.ask`). On all subsequent
 * cycles with `drift < REQUOTE_BPS`, `perp-maker` slept and NEVER re-quoted the missing side,
 * contradicting `orders.ts:191` ("Re-quotes next cycle").
 */
export function shouldRequoteMaker(input: MakerRequoteCheckInput): MakerRequoteDecision {
  const missingAllowedBid = input.allowBid && !input.resting.bidOrderId;
  const missingAllowedAsk = input.allowAsk && !input.resting.askOrderId;

  if (!input.resting.bidOrderId && !input.resting.askOrderId) {
    return {
      shouldRequote: true,
      missingAllowedBid,
      missingAllowedAsk,
      driftBps: Number.POSITIVE_INFINITY,
      reason: "No resting quotes on book — initial quote placement required",
    };
  }

  if (missingAllowedBid || missingAllowedAsk) {
    const missingLabel = missingAllowedBid && missingAllowedAsk ? "both bid & ask" : missingAllowedBid ? "bid" : "ask";
    return {
      shouldRequote: true,
      missingAllowedBid,
      missingAllowedAsk,
      driftBps: 0,
      reason: `Missing allowed ${missingLabel} leg (skipped on prior cycle due to PostOnlyWouldCross or inventory cap) — re-quoting immediately`,
    };
  }

  if (!input.resting.atMarkPriceRaw || input.resting.atMarkPriceRaw <= 0n) {
    return {
      shouldRequote: true,
      missingAllowedBid: false,
      missingAllowedAsk: false,
      driftBps: Number.POSITIVE_INFINITY,
      reason: "No baseline mark price recorded — re-quoting",
    };
  }

  const diff =
    input.currentMarkPriceRaw >= input.resting.atMarkPriceRaw
      ? input.currentMarkPriceRaw - input.resting.atMarkPriceRaw
      : input.resting.atMarkPriceRaw - input.currentMarkPriceRaw;
  const driftBps = Number((diff * 100_000n) / input.resting.atMarkPriceRaw) / 10;

  if (driftBps >= input.requoteBps) {
    return {
      shouldRequote: true,
      missingAllowedBid: false,
      missingAllowedAsk: false,
      driftBps,
      reason: `Mark moved ${driftBps.toFixed(2)} bps >= threshold ${input.requoteBps} bps — refreshing quotes`,
    };
  }

  return {
    shouldRequote: false,
    missingAllowedBid: false,
    missingAllowedAsk: false,
    driftBps,
    reason: `Both allowed legs resting and mark drift ${driftBps.toFixed(2)} bps < ${input.requoteBps} bps — preserving queue priority`,
  };
}

/**
 * Computes exact BigInt bid/ask post-only maker quotes around `markPriceRaw` without IEEE-754 float overflow.
 */
export function buildMakerQuotes(p: {
  markPriceRaw: bigint;
  tickSize: bigint;
  lotSize: bigint;
  baseDecimals: number;
  spreadBps: number;
  orderNotionalUsdso: number;
}): { bidPriceRaw: bigint; askPriceRaw: bigint; quantityRaw: bigint } {
  const halfSpreadBps = p.spreadBps / 2;
  const bidPriceRaw = scalePriceByBps(p.markPriceRaw, -halfSpreadBps, p.tickSize, "buy");
  const askPriceRaw = scalePriceByBps(p.markPriceRaw, +halfSpreadBps, p.tickSize, "sell");

  const oneBase = 10n ** BigInt(p.baseDecimals);
  const notionalRaw = toRawExact(p.orderNotionalUsdso, 18);
  const rawQty = (notionalRaw * oneBase) / p.markPriceRaw;
  const quantityRaw = alignQuantity(rawQty, p.lotSize);

  return { bidPriceRaw, askPriceRaw, quantityRaw };
}

/**
 * Builds an exact tick-aligned OCO Take-Profit + Stop-Loss bracket for both:
 * - Direct EOA mode (on-chain `PerpStopOrderRegistry` linked `linkOco` stops)
 * - Trading-Key mode (client-watched exits via `evaluateWatchedExit`)
 *
 * Fixes BUG-03 in `strategies/perp-starter/src/index.ts:174-175`, where watched-exit triggers
 * were computed via `BigInt(Math.round(mark * (1 ± PCT / 100) * 1e18))` without `alignPrice`.
 */
export function buildOcoBracket(p: {
  positionSide: "long" | "short";
  entryMarkPriceRaw: bigint;
  quantityRaw: bigint;
  tickSize: bigint;
  takeProfitPct: number;
  stopLossPct: number;
}): OcoBracketPlan {
  const isLong = p.positionSide === "long";
  const exitSide: OrderSide = isLong ? "sell" : "buy";
  const tpBps = p.takeProfitPct * 100;
  const slBps = p.stopLossPct * 100;

  const takeProfitTriggerPriceRaw = scalePriceByBps(
    p.entryMarkPriceRaw,
    isLong ? +tpBps : -tpBps,
    p.tickSize,
    exitSide,
  );
  const stopLossTriggerPriceRaw = scalePriceByBps(
    p.entryMarkPriceRaw,
    isLong ? -slBps : +slBps,
    p.tickSize,
    exitSide,
  );

  return {
    positionSide: p.positionSide,
    exitSide,
    quantityRaw: p.quantityRaw,
    takeProfitTriggerPriceRaw,
    takeProfitTriggerCondition: isLong ? TRIGGER_GTE : TRIGGER_LTE,
    stopLossTriggerPriceRaw,
    stopLossTriggerCondition: isLong ? TRIGGER_LTE : TRIGGER_GTE,
  };
}

/**
 * Evaluates whether a watched OCO bracket has triggered at `liveMarkPriceRaw`.
 */
export function evaluateWatchedExit(
  bracket: OcoBracketPlan,
  liveMarkPriceRaw: bigint,
): { triggered: boolean; leg?: "take-profit" | "stop-loss"; triggerPriceRaw?: bigint } {
  const isLong = bracket.positionSide === "long";
  const tpHit = isLong
    ? liveMarkPriceRaw >= bracket.takeProfitTriggerPriceRaw
    : liveMarkPriceRaw <= bracket.takeProfitTriggerPriceRaw;
  if (tpHit) {
    return {
      triggered: true,
      leg: "take-profit",
      triggerPriceRaw: bracket.takeProfitTriggerPriceRaw,
    };
  }

  const slHit = isLong
    ? liveMarkPriceRaw <= bracket.stopLossTriggerPriceRaw
    : liveMarkPriceRaw >= bracket.stopLossTriggerPriceRaw;
  if (slHit) {
    return {
      triggered: true,
      leg: "stop-loss",
      triggerPriceRaw: bracket.stopLossTriggerPriceRaw,
    };
  }

  return { triggered: false };
}
