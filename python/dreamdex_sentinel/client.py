"""Zero-dependency Python client for Somnia Hideki (50383) GraphQL Indexer & JSON-RPC."""

from __future__ import annotations
import json
import urllib.request
from typing import Any, Dict, List
from .quant import SOMNIA_HIDEKI_ADDRESSES


class SomniaHidekiPerpClient:
    """Queries live perpetual markets and chain state on Somnia Hideki Testnet (Chain 50383)."""

    def __init__(
        self,
        rpc_url: str = str(SOMNIA_HIDEKI_ADDRESSES["rpc_url"]),
        indexer_url: str = str(SOMNIA_HIDEKI_ADDRESSES["indexer_url"]),
    ) -> None:
        self.rpc_url = rpc_url
        self.indexer_url = indexer_url

    def get_block_number(self) -> int:
        payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_blockNumber", "params": []}).encode("utf-8")
        req = urllib.request.Request(self.rpc_url, data=payload, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return int(data["result"], 16)

    def fetch_perp_markets(self) -> List[Dict[str, Any]]:
        query = """
        query PerpMarkets {
          Market(where: { marketType: { _eq: "PERP" } }, limit: 50) {
            poolAddress
            baseSymbol
            quoteSymbol
            baseDecimals
            quoteDecimals
            tickSize
            lotSize
            minQuantity
            marginBank
            initialMarginBps
            fundingRate
            indexPrice
            stopRegistry
          }
        }
        """
        payload = json.dumps({"query": query}).encode("utf-8")
        req = urllib.request.Request(self.indexer_url, data=payload, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        return body.get("data", {}).get("Market", [])
