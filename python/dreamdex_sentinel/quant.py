"""Exact Decimal/Int quant math & bug-fix kernels for dreamDEX Perps on Somnia (Chain 50383)."""

from __future__ import annotations
from dataclasses import dataclass
from decimal import Decimal, ROUND_DOWN
from typing import Dict, List, Optional

SOMNIA_HIDEKI_ADDRESSES: Dict[str, object] = {
    "chain_id": 50383,
    "rpc_url": "https://api.hideki2.infra.testnet.somnia.network",
    "indexer_url": "https://hideki-dev.smk.somnia.host/v1/graphql",
    "margin_bank": "0x478769E1177C0773c43A593DCCc4Ad15F15F1394",
    "collateral_token": "0xed7993A74dAe1e6656B704A424DcD8711aAf4F72",
    "perp_pool_factory": "0xE631fAEE547baeE07353E290f0562ea67d856560",
    "liquidation_engine": "0xA66d3C24Ad4a389d863846905D8173e1017e9F4D",
    "insurance_fund": "0x50826894D47C6D4f3BeA38BFDC7Dc5c5be171b80",
    "voucher_distributor": "0x2ACD9EFdA721450906bfE1bef3edE269636E42C4",
    "operator_permissions_registry": "0x6B2FbfeD328FF5F20C0BE7D3C3437613aFFE8D3a",
    "multicall3": "0xcA11bde05977b3631167028862bE2a173976CA11",
}

SECONDS_PER_YEAR = 365 * 24 * 3600
BPS_DENOMINATOR = 10_000


def to_raw_exact(human: float | str | Decimal, decimals: int) -> int:
    """Converts human number/string to exact integer raw units without 9-decimal truncation or float overflow."""
    d = Decimal(str(human))
    scale = Decimal(10) ** decimals
    return int((d * scale).to_integral_value(rounding=ROUND_DOWN))


def from_raw_exact(raw: int, decimals: int) -> float:
    """Converts integer raw units to float for display."""
    return float(Decimal(raw) / (Decimal(10) ** decimals))


def div_ceil(a: int, b: int) -> int:
    if b <= 0:
        raise ValueError("divisor must be > 0")
    if a <= 0:
        return int(Decimal(a) // Decimal(b))
    return (a + b - 1) // b


def align_price(raw_price: int, tick_size: int, side: str) -> int:
    if tick_size <= 0 or raw_price <= 0:
        return max(0, raw_price)
    if side == "buy":
        return (raw_price // tick_size) * tick_size
    return div_ceil(raw_price, tick_size) * tick_size


def align_quantity(raw_quantity: int, lot_size: int) -> int:
    if lot_size <= 0 or raw_quantity <= 0:
        return max(0, raw_quantity)
    return (raw_quantity // lot_size) * lot_size


def funding_rate_to_apr_pct(funding_rate_raw: int, funding_interval_sec: int = 28_800) -> float:
    if funding_interval_sec <= 0:
        return 0.0
    periods_per_year = SECONDS_PER_YEAR / funding_interval_sec
    return abs(funding_rate_raw / 1e18) * periods_per_year * 100.0


@dataclass
class CarrySliceDecision:
    action: str
    side: Optional[str]
    add_notional_usdso: float
    held_notional_usdso: float


def compute_carry_slice(
    current_position_contracts: float,
    current_position_side: Optional[str],
    pay_side: str,
    mark_price_human: float,
    funding_apr_pct: float,
    enter_apr_pct: float = 25.0,
    exit_apr_pct: float = 5.0,
    slice_usdso: float = 50.0,
    max_position_usdso: float = 200.0,
) -> CarrySliceDecision:
    """Fixes BUG-04: scales carry position up to max_position_usdso across poll cycles."""
    has_pos = current_position_contracts > 0 and current_position_side is not None
    held_usdso = current_position_contracts * mark_price_human if has_pos else 0.0
    desired_pos_side = "short" if pay_side == "sell" else "long"

    if has_pos:
        sign_flipped = current_position_side != desired_pos_side and funding_apr_pct > 0
        if sign_flipped or funding_apr_pct < exit_apr_pct:
            return CarrySliceDecision(
                action="exit",
                side="sell" if current_position_side == "long" else "buy",
                add_notional_usdso=0.0,
                held_notional_usdso=held_usdso,
            )

    if funding_apr_pct >= enter_apr_pct and (not has_pos or current_position_side == desired_pos_side):
        remaining = max_position_usdso - held_usdso
        if remaining <= 1e-6:
            return CarrySliceDecision(action="hold", side=None, add_notional_usdso=0.0, held_notional_usdso=held_usdso)
        add_usdso = min(slice_usdso, remaining)
        return CarrySliceDecision(
            action="scale_in" if has_pos else "enter",
            side=pay_side,
            add_notional_usdso=add_usdso,
            held_notional_usdso=held_usdso,
        )

    return CarrySliceDecision(action="hold", side=None, add_notional_usdso=0.0, held_notional_usdso=held_usdso)


def compute_effective_margin_requirement(
    notional_usdso: float,
    initial_margin_bps: int,
    requested_leverage_x: int,
    effective_imf_bps: Optional[int] = None,
    account_max_leverage_x: Optional[int] = None,
    adverse_slippage_bps: int = 0,
    taker_fee_bps_times_1k: int = 5000,
) -> float:
    """Fixes BUG-07: computes full collateral required including leverage surcharge & adverse gap."""
    eff_imf = max(initial_margin_bps, effective_imf_bps or initial_margin_bps)
    market_max_lev = max(1, 10_000 // eff_imf)
    eff_lev = min(max(1, requested_leverage_x), market_max_lev)
    if account_max_leverage_x and account_max_leverage_x > 0:
        eff_lev = min(eff_lev, account_max_leverage_x)

    lev_im_bps = (10_000 + eff_lev - 1) // eff_lev
    applied_im_bps = max(eff_imf, lev_im_bps)

    im_usdso = notional_usdso * applied_im_bps / 10_000.0
    adverse_usdso = notional_usdso * max(0, adverse_slippage_bps) / 10_000.0
    fee_usdso = notional_usdso * (taker_fee_bps_times_1k / 10_000_000.0)
    return im_usdso + adverse_usdso + fee_usdso


def compute_perp_liquidation_price(
    equity: int,
    mm_req: int,
    size: int,
    mark_price: int,
    maintenance_margin_bps: int,
    one_base: int,
) -> Optional[int]:
    """Exact integer port of perpLiquidationPrice."""
    if size == 0 or one_base <= 0:
        return None
    is_long = size > 0
    abs_size = abs(size)
    buffer = equity - mm_req
    factor = (BPS_DENOMINATOR - maintenance_margin_bps) if is_long else (BPS_DENOMINATOR + maintenance_margin_bps)
    if factor <= 0:
        return 0
    denom = abs_size * factor
    num = buffer * one_base * BPS_DENOMINATOR
    if num >= 0:
        delta = num // denom
    else:
        delta = -((-num + denom - 1) // denom)
    raw_liq = (mark_price - delta) if is_long else (mark_price + delta)
    return max(0, raw_liq)


def plan_emergency_deleverage(
    size: int,
    lot_size: int,
    min_quantity: int,
    priceable: bool,
    mark_price: int,
    book_touch_price: int,
    resting_reducing_order_ids: List[str],
    effective_reducing_capacity: int,
    cancel_resting_first: bool = True,
) -> Dict[str, object]:
    """Fixes BUG-01: supports stale-oracle emergency closes and cancels resting reducing orders first."""
    abs_size = abs(size)
    if abs_size == 0:
        return {"can_execute": False, "close_quantity_raw": 0, "orders_to_cancel": []}
    orders_to_cancel = list(resting_reducing_order_ids) if cancel_resting_first else []
    avail = abs_size if cancel_resting_first else effective_reducing_capacity
    aligned = align_quantity(min(abs_size, avail), max(1, lot_size))
    ref_price = book_touch_price if book_touch_price > 0 else mark_price
    can_exec = ref_price > 0 and aligned >= min_quantity and aligned > 0
    return {
        "can_execute": can_exec,
        "used_stale_oracle_fallback": not priceable,
        "orders_to_cancel": orders_to_cancel,
        "close_side": "sell" if size > 0 else "buy",
        "close_quantity_raw": aligned,
    }


def should_requote_maker(
    current_mark_raw: int,
    at_mark_raw: Optional[int],
    bid_order_id: Optional[str],
    ask_order_id: Optional[str],
    allow_bid: bool,
    allow_ask: bool,
    requote_bps: float = 15.0,
) -> bool:
    """Fixes BUG-05: re-quotes immediately if an allowed side is missing after PostOnlyWouldCross."""
    if not bid_order_id and not ask_order_id:
        return True
    if (allow_bid and not bid_order_id) or (allow_ask and not ask_order_id):
        return True
    if not at_mark_raw or at_mark_raw <= 0:
        return True
    drift_bps = abs(current_mark_raw - at_mark_raw) * 10_000 / at_mark_raw
    return drift_bps >= requote_bps
