"""dreamDEX Perps Sentinel — Python Companion Quant & Somnia Hideki (50383) Analytics SDK."""

from .quant import (
    SOMNIA_HIDEKI_ADDRESSES,
    to_raw_exact,
    from_raw_exact,
    align_price,
    align_quantity,
    funding_rate_to_apr_pct,
    compute_carry_slice,
    compute_effective_margin_requirement,
    compute_perp_liquidation_price,
    plan_emergency_deleverage,
    should_requote_maker,
)
from .client import SomniaHidekiPerpClient

__all__ = [
    "SOMNIA_HIDEKI_ADDRESSES",
    "to_raw_exact",
    "from_raw_exact",
    "align_price",
    "align_quantity",
    "funding_rate_to_apr_pct",
    "compute_carry_slice",
    "compute_effective_margin_requirement",
    "compute_perp_liquidation_price",
    "plan_emergency_deleverage",
    "should_requote_maker",
    "SomniaHidekiPerpClient",
]
