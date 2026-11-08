import { defineChain, formatUnits, parseUnits, type Address, type Chain } from "viem";

export type SentinelNetwork = "hideki" | "testnet";

/**
 * Official Somnia Hideki / Tokyo Perps Testnet (chainId 50383) core contract addresses.
 * Fixes BUG-08 where @somnia-chain/markets-sdk@0.30.0 in dreamdex-bot-kit lacked SOMNIA_HIDEKI_TESTNET_ADDRESSES.
 */
export const SOMNIA_HIDEKI_TESTNET_ADDRESSES = {
  chainId: 50383,
  marginBank: "0x478769E1177C0773c43A593DCCc4Ad15F15F1394" as Address,
  collateralToken: "0xed7993A74dAe1e6656B704A424DcD8711aAf4F72" as Address,
  perpPoolFactory: "0xE631fAEE547baeE07353E290f0562ea67d856560" as Address,
  liquidationEngine: "0xA66d3C24Ad4a389d863846905D8173e1017e9F4D" as Address,
  insuranceFund: "0x50826894D47C6D4f3BeA38BFDC7Dc5c5be171b80" as Address,
  voucherDistributor: "0x2ACD9EFdA721450906bfE1bef3edE269636E42C4" as Address,
  operatorPermissionsRegistry: "0x6B2FbfeD328FF5F20C0BE7D3C3437613aFFE8D3a" as Address,
  /**
   * Canonical Multicall3 deployed on Hideki (7,618 bytes bytecode).
   * Note: `@somnia-chain/markets-sdk/chains` `hidekiTestnet` points to `0x540B091b608f54E603c5dC19F6b2d955e1d2D131`,
   * which has 0 bytecode ("0x") on Chain 50383 and causes `getPerpState()` to throw `aggregate3 returned no data ("0x")`!
   */
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11" as Address,
  sdkBrokenMulticall3: "0x540B091b608f54E603c5dC19F6b2d955e1d2D131" as Address,
  btcPerpPool: "0x3b8aa132d05471e4c9268a4d66541fa4a2232023" as Address,
  ethPerpPool: "0x052889598b4d7ffcf61aa04fbdb3148a349257b9" as Address,
  solPerpPool: "0xdf3b47908c5530aa1c8a8652651f6a64c291ec47" as Address,
  nearPerpPool: "0x660b88318c7d4aa39a2ab98f942fb9cecf7a6ca3" as Address,
} as const;

export interface NetworkEndpoints {
  network: SentinelNetwork;
  chainId: number;
  rpcUrl: string;
  wsRpcUrl: string;
  indexerUrl: string;
  operatorRegistry: Address;
  multicall3: Address;
}

export const SENTINEL_ENDPOINTS: Record<SentinelNetwork, NetworkEndpoints> = {
  hideki: {
    network: "hideki",
    chainId: 50383,
    rpcUrl: "https://api.hideki2.infra.testnet.somnia.network",
    wsRpcUrl: "wss://api.hideki2.infra.testnet.somnia.network/ws",
    indexerUrl: "https://hideki-dev.smk.somnia.host/v1/graphql",
    operatorRegistry: SOMNIA_HIDEKI_TESTNET_ADDRESSES.operatorPermissionsRegistry,
    multicall3: SOMNIA_HIDEKI_TESTNET_ADDRESSES.multicall3,
  },
  testnet: {
    network: "testnet",
    chainId: 50312,
    rpcUrl: "https://api.infra.testnet.somnia.network",
    wsRpcUrl: "wss://api.infra.testnet.somnia.network/ws",
    indexerUrl: "https://dev.smk.somnia.host/v1/graphql",
    operatorRegistry: "0x15C7e8CE38F021c5b45d098AaD788f63090bF20A" as Address,
    multicall3: "0x841b8199E6d3Db3C6f264f6C2bd8848b3cA64223" as Address,
  },
};

/**
 * Builds the Viem Chain definition WITH `contracts.multicall3` configured.
 *
 * Fixes BUG-06: `@dreamdex-bot-kit/perp-core` `makeChain()` omitted `contracts.multicall3`,
 * causing `@somnia-chain/markets-sdk` `getPerpState()` (`client.chain?.contracts?.multicall3?.address !== undefined`)
 * to fall back from 1 batched `multicall3` RPC request to 10 individual `readContract` RPC requests per market.
 */
export function makeSentinelChain(network: SentinelNetwork = "hideki", overrides?: Partial<NetworkEndpoints>): Chain {
  const base = { ...SENTINEL_ENDPOINTS[network], ...overrides };
  return defineChain({
    id: base.chainId,
    name: `Somnia (${base.network})`,
    nativeCurrency: { name: "SOMI", symbol: "SOMI", decimals: 18 },
    rpcUrls: {
      default: {
        http: [base.rpcUrl],
        webSocket: [base.wsRpcUrl],
      },
    },
    contracts: {
      multicall3: {
        address: base.multicall3,
      },
    },
  });
}

/**
 * Expands a numeric or scientific-notation string into a plain fixed-point decimal string
 * with up to `decimals` fractional digits (truncated toward zero), without IEEE-754 float overflow.
 */
function normalizeDecimalString(input: number | string, decimals: number): string {
  if (typeof input === "number" && !Number.isFinite(input)) {
    throw new Error(`Invalid non-finite number: ${input}`);
  }
  const rawStr = typeof input === "string" ? input.trim() : input.toString();
  const negative = rawStr.startsWith("-");
  const unsigned = negative || rawStr.startsWith("+") ? rawStr.slice(1) : rawStr;

  let mantissa = unsigned;
  let exp = 0;
  if (unsigned.includes("e") || unsigned.includes("E")) {
    const [m = "0", e = "0"] = unsigned.split(/[eE]/);
    mantissa = m;
    exp = parseInt(e, 10);
  }

  const [wholePart = "0", fracPart = ""] = mantissa.split(".");
  const combinedDigits = wholePart + fracPart;
  const decimalPos = wholePart.length + exp;

  let normalizedWhole: string;
  let normalizedFrac: string;

  if (decimalPos <= 0) {
    normalizedWhole = "0";
    normalizedFrac = "0".repeat(-decimalPos) + combinedDigits;
  } else if (decimalPos >= combinedDigits.length) {
    normalizedWhole = combinedDigits + "0".repeat(decimalPos - combinedDigits.length);
    normalizedFrac = "";
  } else {
    normalizedWhole = combinedDigits.slice(0, decimalPos);
    normalizedFrac = combinedDigits.slice(decimalPos);
  }

  const truncatedFrac = normalizedFrac.slice(0, Math.max(0, decimals));
  const cleanWhole = normalizedWhole.replace(/^0+(?=\d)/, "") || "0";
  const result = truncatedFrac.length > 0 ? `${cleanWhole}.${truncatedFrac}` : cleanWhole;
  return negative && result !== "0" && !/^0\.0+$/.test(result) ? `-${result}` : result;
}

/**
 * Exact human-to-raw unit conversion supporting any decimal count (6..24+) and scientific notation.
 *
 * Fixes BUG-02: `@dreamdex-bot-kit/perp-core` `toRaw(human, decimals)` used `human.toFixed(Math.min(decimals, 9))`,
 * which silently zeroed all digits beyond 9 decimal places (e.g. `toRaw(1e-10, 18) === 0n` and `NEAR-PERP` 24-decimal
 * truncation) and threw `SyntaxError: Cannot convert 1e+21... to a BigInt` for `human >= 1e21`.
 */
export function toRawExact(human: number | string, decimals: number): bigint {
  const decimalStr = normalizeDecimalString(human, decimals);
  return parseUnits(decimalStr, decimals);
}

/**
 * Converts raw BigInt units back to a floating-point number for display/analytics.
 */
export function fromRawExact(raw: bigint, decimals: number): number {
  return Number(formatUnits(raw, decimals));
}

export function divCeil(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error("divCeil divisor must be > 0");
  if (a <= 0n) return a / b;
  return (a + b - 1n) / b;
}

export function divFloor(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error("divFloor divisor must be > 0");
  const q = a / b;
  const r = a % b;
  return r < 0n ? q - 1n : q;
}

export function divCeilSigned(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error("divCeilSigned divisor must be > 0");
  const q = a / b;
  const r = a % b;
  return r > 0n ? q + 1n : q;
}

/**
 * Aligns a raw price (`1e18` quote units) to the pool's `tickSize` grid.
 * Bids round DOWN (floor) so a limit buy does not cross unintended levels;
 * Asks round UP (ceil) so a limit sell does not undersell.
 */
export function alignPrice(rawPrice: bigint, tickSize: bigint, side: "buy" | "sell"): bigint {
  if (tickSize <= 0n) return rawPrice;
  if (rawPrice <= 0n) return 0n;
  if (side === "buy") {
    return (rawPrice / tickSize) * tickSize;
  }
  return divCeil(rawPrice, tickSize) * tickSize;
}

/**
 * Aligns a raw base quantity DOWN to the pool's `lotSize` grid.
 */
export function alignQuantity(rawQuantity: bigint, lotSize: bigint): bigint {
  if (lotSize <= 0n) return rawQuantity;
  if (rawQuantity <= 0n) return 0n;
  return (rawQuantity / lotSize) * lotSize;
}

/**
 * Scales a raw 1e18 price by `bpsDelta` basis points in pure BigInt arithmetic and aligns to `tickSize`.
 *
 * Fixes BUG-03: Eliminates `BigInt(Math.round(price * (1 + bps / 10000) * 1e18))` across `closePosition`,
 * `perp-starter`, `perp-maker`, and `perp-funding`, where IEEE-754 double precision overflowed
 * `Number.MAX_SAFE_INTEGER` by 8,400,000x on BTC-PERP (~$75,821.33).
 */
export function scalePriceByBps(
  rawPrice: bigint,
  bpsDelta: number,
  tickSize: bigint,
  side: "buy" | "sell",
): bigint {
  const scaleBps = BigInt(Math.round((10_000 + bpsDelta) * 1_000));
  const denominator = 10_000_000n;
  const scaled =
    side === "buy"
      ? (rawPrice * scaleBps) / denominator
      : divCeil(rawPrice * scaleBps, denominator);
  return alignPrice(scaled, tickSize, side);
}
