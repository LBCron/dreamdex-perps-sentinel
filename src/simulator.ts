import { divCeil, divCeilSigned, divFloor, fromRawExact } from "./chain.js";
import { classifyHealthAction, computePerpLiquidationPrice, type HealthStage } from "./liquidation-guard.js";

export interface SimPosition {
  symbol: string;
  poolAddress: `0x${string}`;
  size: bigint;
  avgEntryPrice: bigint;
  entryFundingIndex: bigint;
  oneBase: bigint;
  initialMarginBps: bigint;
  maintenanceMarginBps: bigint;
  markPrice: bigint;
  cumulativeFundingIndex: bigint;
  priceable: boolean;
}

export interface SimTradeFill {
  symbol: string;
  isBid: boolean;
  quantity: bigint;
  fillPrice: bigint;
  feeBpsTimes1k?: bigint;
}

export interface SimTradeSettlementResult {
  realizedPnl: bigint;
  fundingSettled: bigint;
  fee: bigint;
  newSize: bigint;
  newAvgEntryPrice: bigint;
  collateralBalanceAfter: bigint;
  equityAfter: bigint;
  mmReqAfter: bigint;
  liquidationPriceAfter: bigint | null;
}

const BPS_DENOMINATOR = 10_000n;
const BPS_TIMES_1K_DENOMINATOR = 10_000_000n;
const FUNDING_PRECISION = 10n ** 18n;

function absBigInt(x: bigint): bigint {
  return x < 0n ? -x : x;
}

/**
 * Deterministic cross-margin MarginBank + PerpPool simulator.
 * Mirrors `MarginBank.settleTrade` (4-case OPEN / INCREASE / REDUCE / FLIP),
 * `divCeilSigned` whole-position funding settlement, floored realized PnL,
 * truncated unrealized PnL, and cross-margin health/liquidation math.
 */
export class SentinelCrossMarginSimulator {
  private collateralBalance: bigint;
  private positions = new Map<string, SimPosition>();

  constructor(initialCollateralRaw: bigint) {
    this.collateralBalance = initialCollateralRaw;
  }

  public registerMarket(params: {
    symbol: string;
    poolAddress: `0x${string}`;
    baseDecimals: number;
    initialMarginBps: number;
    maintenanceMarginBps: number;
    markPrice: bigint;
    cumulativeFundingIndex?: bigint;
  }): void {
    this.positions.set(params.symbol, {
      symbol: params.symbol,
      poolAddress: params.poolAddress,
      size: 0n,
      avgEntryPrice: 0n,
      entryFundingIndex: params.cumulativeFundingIndex ?? 0n,
      oneBase: 10n ** BigInt(params.baseDecimals),
      initialMarginBps: BigInt(params.initialMarginBps),
      maintenanceMarginBps: BigInt(params.maintenanceMarginBps),
      markPrice: params.markPrice,
      cumulativeFundingIndex: params.cumulativeFundingIndex ?? 0n,
      priceable: true,
    });
  }

  public updateMarketState(
    symbol: string,
    update: { markPrice?: bigint; cumulativeFundingIndex?: bigint; priceable?: boolean },
  ): void {
    const pos = this.positions.get(symbol);
    if (!pos) throw new Error(`Unknown market ${symbol}`);
    if (update.markPrice !== undefined) pos.markPrice = update.markPrice;
    if (update.cumulativeFundingIndex !== undefined) pos.cumulativeFundingIndex = update.cumulativeFundingIndex;
    if (update.priceable !== undefined) pos.priceable = update.priceable;
  }

  public deposit(amountRaw: bigint): void {
    if (amountRaw <= 0n) throw new Error("deposit amount must be > 0");
    this.collateralBalance += amountRaw;
  }

  public getPosition(symbol: string): SimPosition {
    const pos = this.positions.get(symbol);
    if (!pos) throw new Error(`Unknown market ${symbol}`);
    return { ...pos };
  }

  /**
   * Computes whole-account cross-margin equity, IM requirement, and MM requirement.
   */
  public getAccountHealth(): {
    collateralBalance: bigint;
    equity: bigint;
    imRequirement: bigint;
    mmRequirement: bigint;
    stage: HealthStage;
    healthRatio: number;
  } {
    let totalUnrealizedPnl = 0n;
    let totalPendingFunding = 0n;
    let imRequirement = 0n;
    let mmRequirement = 0n;

    for (const pos of this.positions.values()) {
      if (pos.size === 0n) continue;
      const absSize = absBigInt(pos.size);
      // PerpMath.unrealizedPnl truncates toward zero
      const uPnl = ((pos.markPrice - pos.avgEntryPrice) * pos.size) / pos.oneBase;
      const funding = divCeilSigned(
        pos.size * (pos.cumulativeFundingIndex - pos.entryFundingIndex),
        FUNDING_PRECISION * pos.oneBase,
      );
      const notional = (absSize * pos.markPrice) / pos.oneBase;
      const im = divCeil(notional * pos.initialMarginBps, BPS_DENOMINATOR);
      const mm = divCeil(notional * pos.maintenanceMarginBps, BPS_DENOMINATOR);

      totalUnrealizedPnl += uPnl;
      totalPendingFunding += funding;
      imRequirement += im;
      mmRequirement += mm;
    }

    const equity = this.collateralBalance + totalUnrealizedPnl - totalPendingFunding;
    const classified = classifyHealthAction(equity, mmRequirement);
    return {
      collateralBalance: this.collateralBalance,
      equity,
      imRequirement,
      mmRequirement,
      stage: classified.stage,
      healthRatio: classified.healthRatio,
    };
  }

  /**
   * Settles a fill exactly as `MarginBank.settleTrade` does:
   * 1. Settles pending funding on the WHOLE existing position (`pos.size`) before mutating size.
   * 2. Applies 4-case position transition (OPEN, INCREASE with floored VWAP, REDUCE/CLOSE with floored realized PnL, FLIP).
   * 3. Deducts fill fee (`BPS_TIMES_1K`).
   */
  public settleTrade(fill: SimTradeFill): SimTradeSettlementResult {
    const pos = this.positions.get(fill.symbol);
    if (!pos) throw new Error(`Unknown market ${fill.symbol}`);
    if (fill.quantity <= 0n) throw new Error("quantity must be > 0");

    // 1. Settle accrued funding on the WHOLE position first (MarginBank.sol:324)
    const fundingSettled =
      pos.size === 0n
        ? 0n
        : divCeilSigned(
            pos.size * (pos.cumulativeFundingIndex - pos.entryFundingIndex),
            FUNDING_PRECISION * pos.oneBase,
          );
    this.collateralBalance -= fundingSettled;
    pos.entryFundingIndex = pos.cumulativeFundingIndex;

    // 2. 4-case position update
    const delta = fill.isBid ? fill.quantity : -fill.quantity;
    const oldSize = pos.size;
    const absOldSize = absBigInt(oldSize);
    let realizedPnl = 0n;

    if (oldSize === 0n) {
      // Case 1: OPEN
      pos.size = delta;
      pos.avgEntryPrice = fill.fillPrice;
    } else if (oldSize > 0n === delta > 0n) {
      // Case 2: INCREASE (floored VWAP)
      pos.size = oldSize + delta;
      pos.avgEntryPrice = (absOldSize * pos.avgEntryPrice + fill.quantity * fill.fillPrice) / (absOldSize + fill.quantity);
    } else {
      // Cases 3 & 4: REDUCE / CLOSE or FLIP
      const sign = oldSize > 0n ? 1n : -1n;
      const closed = fill.quantity <= absOldSize ? fill.quantity : absOldSize;
      realizedPnl = divFloor((fill.fillPrice - pos.avgEntryPrice) * sign * closed, pos.oneBase);
      pos.size = oldSize + delta;
      if (fill.quantity > absOldSize) {
        // Case 4: FLIP — remainder opens fresh at fillPrice
        pos.avgEntryPrice = fill.fillPrice;
      } else if (pos.size === 0n) {
        // Full close clears entry price
        pos.avgEntryPrice = 0n;
      }
    }

    // 3. Fee calculation
    const feeBpsTimes1k = fill.feeBpsTimes1k ?? 5_000n; // default 5 bps taker
    const fillNotional = (fill.quantity * fill.fillPrice) / pos.oneBase;
    const fee =
      feeBpsTimes1k >= 0n
        ? (fillNotional * feeBpsTimes1k) / BPS_TIMES_1K_DENOMINATOR
        : -((fillNotional * -feeBpsTimes1k) / BPS_TIMES_1K_DENOMINATOR);

    this.collateralBalance = this.collateralBalance + realizedPnl - fee;

    const health = this.getAccountHealth();
    const liquidationPriceAfter = computePerpLiquidationPrice({
      equity: health.equity,
      mmReq: health.mmRequirement,
      size: pos.size,
      markPrice: pos.markPrice,
      maintenanceMarginBps: pos.maintenanceMarginBps,
      oneBase: pos.oneBase,
    });

    return {
      realizedPnl,
      fundingSettled,
      fee,
      newSize: pos.size,
      newAvgEntryPrice: pos.avgEntryPrice,
      collateralBalanceAfter: this.collateralBalance,
      equityAfter: health.equity,
      mmReqAfter: health.mmRequirement,
      liquidationPriceAfter,
    };
  }

  public formatSummary(): string {
    const h = this.getAccountHealth();
    return `Equity: $${fromRawExact(h.equity, 18).toFixed(2)} | MM Req: $${fromRawExact(h.mmRequirement, 18).toFixed(2)} | Health: ${Number.isFinite(h.healthRatio) ? `${h.healthRatio.toFixed(2)}x` : "INF"} (${h.stage})`;
  }
}
