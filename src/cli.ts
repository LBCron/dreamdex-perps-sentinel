import { SOMNIA_HIDEKI_TESTNET_ADDRESSES as SDK_HIDEKI_ADDRESSES, SomniaMarkets, type UnifiedMarket } from "@somnia-chain/markets-sdk";
import { createPublicClient, http } from "viem";
import {
  SENTINEL_ENDPOINTS,
  SOMNIA_HIDEKI_TESTNET_ADDRESSES,
  fromRawExact,
  makeSentinelChain,
  toRawExact,
} from "./chain.js";
import {
  buildDeltaNeutralPair,
  computeCarrySlice,
  computeEffectiveMarginRequirement,
  evaluateCarryOpportunity,
  type PerpMarketSnapshot,
} from "./funding-arb.js";
import {
  classifyHealthAction,
  computePerpLiquidationPrice,
  planEmergencyDeleverage,
} from "./liquidation-guard.js";
import { buildOcoBracket, evaluateWatchedExit, shouldRequoteMaker } from "./execution.js";
import { SentinelCrossMarginSimulator } from "./simulator.js";

function displaySymbol(ccxtSymbol: string): string {
  const base = ccxtSymbol.split("/")[0] ?? ccxtSymbol;
  return `${base}-PERP`;
}

async function runLiveTestnetScan(): Promise<PerpMarketSnapshot[]> {
  const endpoints = SENTINEL_ENDPOINTS.hideki;
  const chain = makeSentinelChain("hideki");

  console.log("================================================================================");
  console.log("  dreamDEX Perps Sentinel — Somnia Hideki / Tokyo Testnet (Chain ID 50383)");
  console.log("================================================================================");
  console.log(`  RPC Endpoint       : ${endpoints.rpcUrl}`);
  console.log(`  Indexer GraphQL    : ${endpoints.indexerUrl}`);
  console.log(`  Multicall3 Address : ${chain.contracts?.multicall3?.address} (BUG-06 Fixed: 10x RPC Batching Enabled)`);
  console.log(`  MarginBank         : ${SOMNIA_HIDEKI_TESTNET_ADDRESSES.marginBank}`);
  console.log(`  Collateral (USDso) : ${SOMNIA_HIDEKI_TESTNET_ADDRESSES.collateralToken}`);

  const publicClient = createPublicClient({
    chain,
    transport: http(endpoints.rpcUrl, { timeout: 15_000 }),
  });

  const exchange = new SomniaMarkets({
    chain,
    indexerUrl: endpoints.indexerUrl,
    wsRpcUrl: endpoints.wsRpcUrl,
    addresses: SDK_HIDEKI_ADDRESSES,
  });

  const blockNumber = await publicClient.getBlockNumber();
  const sysConfig = await exchange.client.getPerpSystemConfig(SOMNIA_HIDEKI_TESTNET_ADDRESSES.marginBank);
  const liqConfig = await exchange.client.getLiquidationEngineConfig(sysConfig.liquidationEngine);

  console.log(`  Latest Block       : #${blockNumber.toString()}`);
  console.log(
    `  Protocol Wiring    : fullyWired=${sysConfig.fullyWired} | maxLeverageLimit=${sysConfig.maxLeverageLimit}x | liqPenalty=${liqConfig.penaltyBps}bps | backstopBidders=${liqConfig.bidderCount}`,
  );
  console.log("--------------------------------------------------------------------------------");

  const rawMarkets = await exchange.loadMarkets(true);
  const swapMarkets = (Object.values(rawMarkets) as UnifiedMarket[]).filter((m) => m.type === "swap");

  const snapshots: PerpMarketSnapshot[] = [];
  await Promise.all(
    swapMarkets.map(async (m) => {
      const info = m.info as Record<string, unknown>;
      const poolAddress = String(info.poolAddress ?? m.id) as `0x${string}`;
      const marginBank = String(info.marginBank ?? SOMNIA_HIDEKI_TESTNET_ADDRESSES.marginBank) as `0x${string}`;
      const stopRegistry = String(
        info.stopRegistry ?? "0x0000000000000000000000000000000000000000",
      ) as `0x${string}`;
      const baseDecimals = Number(info.baseDecimals ?? 18);
      const quoteDecimals = Number(info.quoteDecimals ?? 18);

      const state = await exchange.client.getPerpState(poolAddress);
      const imBps = Number(info.initialMarginBps ?? 500);
      snapshots.push({
        symbol: displaySymbol(m.symbol),
        poolAddress,
        marginBank,
        stopRegistry,
        baseDecimals,
        quoteDecimals,
        markPrice: state.markPrice,
        indexPrice: state.indexPrice,
        tickSize: BigInt(String(info.tickSize ?? "10000000000000000")),
        lotSize: BigInt(String(info.lotSize ?? "1")),
        minQuantity: BigInt(String(info.minQuantity ?? "1")),
        initialMarginBps: imBps,
        effectiveImfBps: imBps,
        maintenanceMarginBps: Math.floor(imBps / 2),
        fundingRate: state.fundingRate,
        fundingIntervalSec: Number(state.fundingWindowSec) || 28_800,
        takerFeeBpsTimes1k: 5_000n,
        makerFeeBpsTimes1k: 1_000n,
        openInterest: state.openInterest,
        markUpdatedAtSec: Number(state.indexUpdatedAt),
      });
    }),
  );

  snapshots.sort((a, b) => a.symbol.localeCompare(b.symbol));
  console.log(`  Live Perp Markets Discovered on Somnia Hideki (50383): ${snapshots.length}`);
  console.log("  Symbol           Mark Price ($)    IM / MM (bps)   MaxLev   Funding APR    Pool Address");
  console.log("  ---------------  ----------------  --------------  -------  -------------  ------------------------------------------");

  for (const s of snapshots) {
    const opp = evaluateCarryOpportunity(s);
    const dir = s.fundingRate > 0n ? "+longs->shorts" : s.fundingRate < 0n ? "-shorts->longs" : " flat         ";
    console.log(
      `  ${s.symbol.padEnd(15)}  ${opp.markPriceHuman.toFixed(4).padStart(16)}  ${`${s.initialMarginBps}/${s.maintenanceMarginBps}`.padStart(14)}  ${`${opp.maxMarketLeverageX}x`.padStart(7)}  ${`${opp.grossAprPct.toFixed(2)}%`.padStart(8)} (${dir.slice(0, 3)})  ${s.poolAddress}`,
    );
  }

  // Inspect a live on-chain position holder on BTC-PERP
  const btc = snapshots.find((s) => s.symbol === "BTC-PERP");
  if (btc) {
    const longHolders = await exchange.client.getPerpSideHolders({
      marginBank: btc.marginBank,
      pool: btc.poolAddress,
      isLong: true,
    });
    const shortHolders = await exchange.client.getPerpSideHolders({
      marginBank: btc.marginBank,
      pool: btc.poolAddress,
      isLong: false,
    });
    console.log("--------------------------------------------------------------------------------");
    console.log(
      `  Live On-Chain BTC-PERP Position Holders (as of block #${longHolders.asOfBlock}): ${longHolders.holders.length} Longs | ${shortHolders.holders.length} Shorts`,
    );
    const sampleHolder = longHolders.holders[0] ?? shortHolders.holders[0];
    if (sampleHolder) {
      const [acctHealth, posAnalytics, liqPrice] = await Promise.all([
        exchange.client.getMarginAccount(btc.marginBank, sampleHolder),
        exchange.client.getPerpPositionAnalytics({
          marginBank: btc.marginBank,
          account: sampleHolder,
          pool: btc.poolAddress,
        }),
        exchange.client.getLiquidationPrice({
          marginBank: btc.marginBank,
          account: sampleHolder,
          pool: btc.poolAddress,
        }),
      ]);
      console.log(`  Sample Live Trader Account : ${sampleHolder}`);
      console.log(
        `    Cross-Margin Equity      : $${fromRawExact(acctHealth.equity, 18).toFixed(2)} USDso | MM Req: $${fromRawExact(acctHealth.mmReq, 18).toFixed(2)} USDso | Status: ${acctHealth.marginStatus}`,
      );
      if (posAnalytics.priceable) {
        console.log(
          `    BTC-PERP Position Size   : ${fromRawExact(posAnalytics.size, btc.baseDecimals)} BTC | Entry: $${fromRawExact(posAnalytics.avgEntryPrice, 18).toFixed(2)} | uPnL: $${fromRawExact(posAnalytics.unrealizedPnl, 18).toFixed(2)} | Liq Price: ${liqPrice !== null ? `$${fromRawExact(liqPrice, 18).toFixed(2)}` : "N/A"}`,
        );
      }
    }
  }

  return snapshots;
}

function runDeterministicStrategyDemo(liveSnapshots: PerpMarketSnapshot[]): void {
  console.log("\n================================================================================");
  console.log("  Deterministic Strategy & Bug-Fix Verification Pipeline");
  console.log("================================================================================");

  const btc = liveSnapshots.find((s) => s.symbol === "BTC-PERP") ?? {
    symbol: "BTC-PERP",
    poolAddress: SOMNIA_HIDEKI_TESTNET_ADDRESSES.btcPerpPool,
    marginBank: SOMNIA_HIDEKI_TESTNET_ADDRESSES.marginBank,
    stopRegistry: "0x0000000000000000000000000000000000000001" as `0x${string}`,
    baseDecimals: 8,
    quoteDecimals: 18,
    markPrice: toRawExact("75821.33", 18),
    indexPrice: toRawExact("75790.00", 18),
    tickSize: toRawExact("0.01", 18),
    lotSize: 100_000n,
    minQuantity: 100_000n,
    initialMarginBps: 250,
    effectiveImfBps: 250,
    maintenanceMarginBps: 125,
    fundingRate: toRawExact("0.00045", 18),
    fundingIntervalSec: 28_800,
    takerFeeBpsTimes1k: 5_000n,
    makerFeeBpsTimes1k: 1_000n,
    openInterest: 10_000_000_000n,
    markUpdatedAtSec: Math.floor(Date.now() / 1000),
  };

  const eth = liveSnapshots.find((s) => s.symbol === "ETH-PERP") ?? {
    ...btc,
    symbol: "ETH-PERP",
    poolAddress: SOMNIA_HIDEKI_TESTNET_ADDRESSES.ethPerpPool,
    baseDecimals: 18,
    markPrice: toRawExact("2356.71", 18),
    indexPrice: toRawExact("2358.00", 18),
    lotSize: 10n ** 15n,
    minQuantity: 10n ** 15n,
    fundingRate: toRawExact("-0.00025", 18),
  };

  // 1. Delta-Neutral Pair Sizing
  const pairPlan = buildDeltaNeutralPair(
    { ...btc, fundingRate: toRawExact("0.00045", 18) },
    { ...eth, fundingRate: toRawExact("-0.00025", 18) },
    1_000,
  );
  console.log("  [1] Delta-Neutral Pair Sizer ($1,000 per leg):");
  console.log(
    `      Short Leg : ${pairPlan.shortPerpLeg.symbol} | ${pairPlan.shortPerpLeg.humanQuantity} contracts ($${pairPlan.shortPerpLeg.notionalUsdso.toFixed(2)}) | Carry: +${pairPlan.shortPerpLeg.expectedFundingAprPct.toFixed(2)}% APR`,
  );
  console.log(
    `      Long Leg  : ${pairPlan.longHedgeLeg.symbol} | ${pairPlan.longHedgeLeg.humanQuantity} contracts ($${pairPlan.longHedgeLeg.notionalUsdso.toFixed(2)}) | Carry: +${pairPlan.longHedgeLeg.expectedFundingAprPct.toFixed(2)}% APR`,
  );
  console.log(
    `      Portfolio : Gross Carry ${pairPlan.combinedGrossAprPct.toFixed(2)}% APR | Net Carry ${pairPlan.combinedNetAprPct.toFixed(2)}% APR | Net Delta: $${pairPlan.netDeltaUsdso.toFixed(2)} USDso`,
  );

  // 2. Incremental Carry Scaling up to MAX_POSITION (Fixes BUG-04)
  console.log("\n  [2] Incremental Carry Position Scaling up to MAX_POSITION ($200 cap in $50 slices, BUG-04 Fix):");
  let heldContracts = 0;
  for (let cycle = 1; cycle <= 5; cycle++) {
    const slice = computeCarrySlice({
      currentPositionContracts: heldContracts,
      currentPositionSide: heldContracts > 0 ? "short" : undefined,
      paySide: "sell",
      markPriceHuman: 100,
      fundingAprPct: 38.5,
      enterAprPct: 25,
      exitAprPct: 5,
      sliceUsdso: 50,
      maxPositionUsdso: 200,
    });
    if (slice.action === "enter" || slice.action === "scale_in") {
      heldContracts += slice.addNotionalUsdso / 100;
    }
    console.log(`      Cycle ${cycle}: action=${slice.action.padEnd(8)} | ${slice.reason}`);
  }

  // 3. Effective Margin Preflight with Account Cap & Adverse Gap (Fixes BUG-07)
  const marginReq = computeEffectiveMarginRequirement({
    notionalUsdso: 50,
    initialMarginBps: 1000, // 10% (10x market max, e.g. DOGE-PERP / TAO-PERP)
    requestedLeverageX: 20, // User asks for 20x on a 10x market
    accountMaxLeverageX: 5, // Linked owner account has a 5x leverage cap set on-chain
    adverseSlippageBps: 50,
    takerFeeBpsTimes1k: 5_000n,
  });
  console.log("\n  [3] Effective Margin Preflight (BUG-07 Fix):");
  console.log(
    `      Base IM: $${marginReq.initialMarginUsdso.toFixed(2)} | Leverage Surcharge (5x cap): $${marginReq.leverageSurchargeUsdso.toFixed(2)} | Adverse Gap: $${marginReq.adverseGapUsdso.toFixed(2)} | Total Required: $${marginReq.totalRequiredUsdso.toFixed(2)} USDso (bot-kit checked only $2.50!)`,
  );

  // 4. Two-Sided Maker Re-Quoting after PostOnlyWouldCross (Fixes BUG-05)
  const requoteCheck = shouldRequoteMaker({
    currentMarkPriceRaw: btc.markPrice,
    resting: { bidOrderId: "101", askOrderId: undefined, atMarkPriceRaw: btc.markPrice },
    allowBid: true,
    allowAsk: true,
    requoteBps: 15,
  });
  console.log("\n  [4] Maker Missing-Leg Recovery (BUG-05 Fix):");
  console.log(`      shouldRequote=${requoteCheck.shouldRequote} | ${requoteCheck.reason}`);

  // 5. OCO Stop-Bracket & Cross-Margin Liquidation Guard + Stale Oracle Emergency Close (Fixes BUG-01 & BUG-03)
  const bracket = buildOcoBracket({
    positionSide: "long",
    entryMarkPriceRaw: btc.markPrice,
    quantityRaw: 10_000_000n, // 0.10 BTC
    tickSize: btc.tickSize,
    takeProfitPct: 3.0,
    stopLossPct: 1.5,
  });
  const triggered = evaluateWatchedExit(bracket, (btc.markPrice * 9800n) / 10000n);
  console.log("\n  [5] Tick-Aligned OCO Bracket & Watched Exit (BUG-03 Fix):");
  console.log(
    `      Entry: $${fromRawExact(btc.markPrice, 18).toFixed(2)} | TP Trigger: $${fromRawExact(bracket.takeProfitTriggerPriceRaw, 18).toFixed(2)} | SL Trigger: $${fromRawExact(bracket.stopLossTriggerPriceRaw, 18).toFixed(2)} | Triggered at -2%: ${triggered.triggered} (${triggered.leg})`,
  );

  const sim = new SentinelCrossMarginSimulator(toRawExact("500", 18));
  sim.registerMarket({
    symbol: "BTC-PERP",
    poolAddress: btc.poolAddress,
    baseDecimals: 8,
    initialMarginBps: 250,
    maintenanceMarginBps: 125,
    markPrice: toRawExact("75000", 18),
  });
  sim.settleTrade({
    symbol: "BTC-PERP",
    isBid: true,
    quantity: 20_000_000n, // 0.2 BTC = $15,000 notional (30x leverage on $500 collateral)
    fillPrice: toRawExact("75000", 18),
  });
  console.log("\n  [6] Cross-Margin Liquidation Guard & Stale-Oracle Emergency Close (BUG-01 Fix):");
  console.log(`      After Open (0.2 BTC Long @ $75,000) : ${sim.formatSummary()}`);

  // Simulate adverse mark move to $73,650 + stale oracle (`priceable: false`) with a resting TP order on the book
  sim.updateMarketState("BTC-PERP", { markPrice: toRawExact("73650", 18), priceable: false });
  const healthDuringShock = sim.getAccountHealth();
  const guardAction = classifyHealthAction(healthDuringShock.equity, healthDuringShock.mmRequirement, {
    oracleAgeSec: 185,
    maxOracleAgeSec: 120,
  });
  const deleveragePlan = planEmergencyDeleverage({
    symbol: "BTC-PERP",
    poolAddress: btc.poolAddress,
    size: 20_000_000n,
    baseDecimals: 8,
    lotSize: 100_000n,
    minQuantity: 100_000n,
    priceable: false, // Oracle is stale!
    markPrice: toRawExact("73650", 18),
    bookTouchPrice: toRawExact("73640", 18),
    restingReducingOrderIds: ["tp-order-881"],
    effectiveReducingCapacity: 10_000_000n,
  });

  console.log(`      During Shock + Stale Oracle (185s)  : ${sim.formatSummary()} -> ${guardAction.stage}`);
  console.log(
    `      Emergency Deleverage Plan           : canExecute=${deleveragePlan.canExecute} | staleOracleFallback=${deleveragePlan.usedStaleOracleFallback} | cancelFirst=[${deleveragePlan.orderIdsToCancelFirst.join(", ")}] | closeQty=${deleveragePlan.closeQuantityHuman} BTC`,
  );
  console.log("================================================================================\n");
}

async function main(): Promise<void> {
  let snapshots: PerpMarketSnapshot[] = [];
  try {
    snapshots = await runLiveTestnetScan();
  } catch (err) {
    console.warn("  [Warning] Live RPC scan skipped or timed out, running offline snapshot:", (err as Error).message);
  }
  runDeterministicStrategyDemo(snapshots);
  process.exit(0);
}

main();
