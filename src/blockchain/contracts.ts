import { Contract, getAddress } from "ethers";
import type { JsonRpcProvider } from "ethers";
import { ERC20_ABI, UNISWAP_V2_PAIR_ABI } from "../abis/index.js";
import type { BotConfig } from "../config.js";
import type { IPoolReader, PoolConfig, PoolReserves, TokenInfo } from "../types.js";
import { ProviderManager } from "./provider.js";

const tokenCache = new Map<string, TokenInfo>();

async function loadToken(provider: JsonRpcProvider, address: string): Promise<TokenInfo> {
  const key = getAddress(address);
  const cached = tokenCache.get(key);
  if (cached) return cached;

  const erc20 = new Contract(key, ERC20_ABI, provider);
  const [decimals, symbol] = await Promise.all([
    erc20.decimals() as Promise<number>,
    erc20.symbol() as Promise<string>,
  ]);
  const info: TokenInfo = { address: key, symbol, decimals: Number(decimals) };
  tokenCache.set(key, info);
  return info;
}

function isWbnbOrBnbQuote(token: TokenInfo, wbnbAddress: string): boolean {
  const addr = token.address.toLowerCase();
  const wbnb = wbnbAddress.toLowerCase();
  return addr === wbnb;
}

export class PoolReader implements IPoolReader {
  constructor(
    private readonly providerManager: ProviderManager,
    private readonly config: BotConfig
  ) {}

  async readPoolReserves(pool: PoolConfig): Promise<PoolReserves> {
    return this.providerManager.withFallback(async (provider) => {
      const pair = new Contract(pool.address, UNISWAP_V2_PAIR_ABI, provider);
      const [token0Addr, token1Addr, reserves, blockNumber] = await Promise.all([
        pair.token0() as Promise<string>,
        pair.token1() as Promise<string>,
        pair.getReserves() as Promise<[bigint, bigint, number]>,
        provider.getBlockNumber(),
      ]);

      const [token0, token1] = await Promise.all([
        loadToken(provider, token0Addr),
        loadToken(provider, token1Addr),
      ]);

      const reserve0 = reserves[0];
      const reserve1 = reserves[1];
      const wpkenLower = this.config.wpkenAddress.toLowerCase();

      let wpknReserve: bigint;
      let quoteReserve: bigint;
      let quoteToken: TokenInfo;

      if (token0.address.toLowerCase() === wpkenLower) {
        wpknReserve = reserve0;
        quoteReserve = reserve1;
        quoteToken = token1;
      } else if (token1.address.toLowerCase() === wpkenLower) {
        wpknReserve = reserve1;
        quoteReserve = reserve0;
        quoteToken = token0;
      } else {
        throw new Error(
          `Pool ${pool.name} (${pool.address}) does not contain wPKN ${this.config.wpkenAddress}`
        );
      }

      if (!isWbnbOrBnbQuote(quoteToken, this.config.wbnbAddress)) {
        // Allow non-WBNB quote but log naming mismatch (e.g. pool labeled BNB may still be WBNB)
      }

      return {
        poolAddress: pool.address,
        poolName: pool.name,
        token0,
        token1,
        reserve0,
        reserve1,
        wpknReserve,
        quoteReserve,
        quoteToken,
        blockNumber,
        timestamp: Math.floor(Date.now() / 1000),
      };
    });
  }

  async getWalletBalances(): Promise<{ wpken: bigint; wbnb: bigint; bnb: bigint }> {
    const wallet = this.config.botWalletAddress;
    if (!wallet) {
      return { wpken: 0n, wbnb: 0n, bnb: 0n };
    }

    return this.providerManager.withFallback(async (provider) => {
      const wpken = new Contract(this.config.wpkenAddress, ERC20_ABI, provider);
      const wbnb = new Contract(this.config.wbnbAddress, ERC20_ABI, provider);
      const [w, b, native] = await Promise.all([
        wpken.balanceOf(wallet) as Promise<bigint>,
        wbnb.balanceOf(wallet) as Promise<bigint>,
        provider.getBalance(wallet),
      ]);
      return { wpken: w, wbnb: b, bnb: native };
    });
  }
}

/** Transaction execution — disabled until explicitly enabled via config. */
export class TransactionExecutor {
  constructor(private readonly config: BotConfig) {}

  private assertExecutionAllowed(feature: "trading" | "liquidity"): void {
    if (this.config.dryRun) {
      throw new Error("DRY_RUN is enabled — transactions blocked");
    }
    if (feature === "trading" && !this.config.enableTrading) {
      throw new Error("ENABLE_TRADING is false — swap blocked");
    }
    if (feature === "liquidity" && !this.config.enableAutoLiquidity) {
      throw new Error("ENABLE_AUTO_LIQUIDITY is false — addLiquidity blocked");
    }
    if (!this.config.privateKey) {
      throw new Error("PRIVATE_KEY not configured");
    }
    throw new Error(
      "Live transaction execution not implemented in v0.1 — monitoring milestone only"
    );
  }

  async executeSwap(_params: unknown): Promise<string> {
    this.assertExecutionAllowed("trading");
    return "";
  }

  async executeAddLiquidity(_params: unknown): Promise<string> {
    this.assertExecutionAllowed("liquidity");
    return "";
  }
}
