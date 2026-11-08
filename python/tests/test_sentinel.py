import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from dreamdex_sentinel import (
    SOMNIA_HIDEKI_ADDRESSES,
    align_price,
    align_quantity,
    compute_carry_slice,
    compute_effective_margin_requirement,
    compute_perp_liquidation_price,
    from_raw_exact,
    funding_rate_to_apr_pct,
    plan_emergency_deleverage,
    should_requote_maker,
    to_raw_exact,
)


class TestDreamDexSentinelPython(unittest.TestCase):
    def test_hideki_addresses(self) -> None:
        self.assertEqual(SOMNIA_HIDEKI_ADDRESSES["chain_id"], 50383)
        self.assertEqual(
            SOMNIA_HIDEKI_ADDRESSES["multicall3"],
            "0xcA11bde05977b3631167028862bE2a173976CA11",
        )

    def test_to_raw_exact_bug02_and_bug03(self) -> None:
        self.assertEqual(to_raw_exact("0.123456789123456", 24), 123456789123456000000000)
        self.assertEqual(to_raw_exact("1e-10", 18), 100_000_000)
        self.assertEqual(to_raw_exact("1e21", 18), 10**39)
        self.assertEqual(to_raw_exact("75821.33", 18), 75821330000000000000000)

    def test_carry_slice_scaling_bug04(self) -> None:
        d1 = compute_carry_slice(0.0, None, "sell", 100.0, 40.0, 25.0, 5.0, 50.0, 200.0)
        self.assertEqual(d1.action, "enter")
        self.assertEqual(d1.add_notional_usdso, 50.0)

        d2 = compute_carry_slice(0.5, "short", "sell", 100.0, 40.0, 25.0, 5.0, 50.0, 200.0)
        self.assertEqual(d2.action, "scale_in")
        self.assertEqual(d2.add_notional_usdso, 50.0)

        d3 = compute_carry_slice(2.0, "short", "sell", 100.0, 40.0, 25.0, 5.0, 50.0, 200.0)
        self.assertEqual(d3.action, "hold")
        self.assertEqual(d3.add_notional_usdso, 0.0)

    def test_effective_margin_bug07(self) -> None:
        req = compute_effective_margin_requirement(
            notional_usdso=100.0,
            initial_margin_bps=1000,
            requested_leverage_x=20,
            account_max_leverage_x=4,
            adverse_slippage_bps=50,
            taker_fee_bps_times_1k=5000,
        )
        self.assertAlmostEqual(req, 25.55, places=4)

    def test_stale_oracle_deleverage_bug01(self) -> None:
        plan = plan_emergency_deleverage(
            size=50_000_000,
            lot_size=100_000,
            min_quantity=100_000,
            priceable=False,
            mark_price=to_raw_exact("75000", 18),
            book_touch_price=to_raw_exact("74950", 18),
            resting_reducing_order_ids=["tp-1"],
            effective_reducing_capacity=10_000_000,
        )
        self.assertTrue(plan["can_execute"])
        self.assertTrue(plan["used_stale_oracle_fallback"])
        self.assertEqual(plan["orders_to_cancel"], ["tp-1"])
        self.assertEqual(plan["close_quantity_raw"], 50_000_000)

    def test_maker_requote_missing_leg_bug05(self) -> None:
        mark = to_raw_exact("75000", 18)
        self.assertTrue(should_requote_maker(mark, mark, "bid-1", None, True, True, 15.0))
        self.assertFalse(should_requote_maker(mark, mark, "bid-1", "ask-1", True, True, 15.0))

    def test_liquidation_price_math(self) -> None:
        liq = compute_perp_liquidation_price(
            equity=to_raw_exact("3750", 18),
            mm_req=to_raw_exact("937.5", 18),
            size=100_000_000,
            mark_price=to_raw_exact("75000", 18),
            maintenance_margin_bps=125,
            one_base=100_000_000,
        )
        self.assertIsNotNone(liq)
        self.assertAlmostEqual(from_raw_exact(liq or 0, 18), 72151.8987, places=2)


if __name__ == "__main__":
    unittest.main()
