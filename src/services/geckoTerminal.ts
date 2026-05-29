/** GeckoTerminal public API — price/reserve hints for non–V2 pools (e.g. Uniswap v4). */

const BASE = "https://api.geckoterminal.com/api/v2";

export interface GeckoPoolSnapshot {
  poolAddress: string;
  name: string;
  priceUsd: number;
  reserveUsd: number;
  wpkenReserveEstimate: bigint | null;
}

export async function fetchPoolByAddress(
  network: string,
  poolAddress: string
): Promise<GeckoPoolSnapshot> {
  const url = `${BASE}/networks/${network}/pools/${poolAddress.toLowerCase()}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`GeckoTerminal ${res.status} for pool ${poolAddress}`);
  }
  const json = (await res.json()) as {
    data: {
      attributes: {
        name: string;
        address: string;
        token_price_usd?: string;
        base_token_price_usd?: string;
        reserve_in_usd?: string;
      };
    };
  };
  const a = json.data.attributes;
  const priceUsd = Number(a.token_price_usd ?? a.base_token_price_usd ?? "0");
  const reserveUsd = Number(a.reserve_in_usd ?? "0");
  return {
    poolAddress: a.address,
    name: a.name,
    priceUsd,
    reserveUsd,
    wpkenReserveEstimate: null,
  };
}
