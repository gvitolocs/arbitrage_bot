import { JsonRpcProvider, Network } from "ethers";
import type { BotConfig } from "../config.js";
import { logger } from "../logger.js";
import { maskRpcUrl } from "./mev.js";

function buildProviders(urls: string[], chainId: number): JsonRpcProvider[] {
  const network = Network.from(chainId);
  return urls.map(
    (url) =>
      new JsonRpcProvider(url, network, {
        staticNetwork: network,
        batchMaxCount: 1,
      })
  );
}

export class ProviderManager {
  private readProviders: JsonRpcProvider[];
  private txProviders: JsonRpcProvider[];
  private readUrls: string[];
  private txUrls: string[];
  private readIndex = 0;
  private txIndex = 0;

  constructor(private readonly config: BotConfig) {
    this.readUrls = config.rpcUrls;
    this.txUrls = config.txRpcUrls;
    this.readProviders = buildProviders(this.readUrls, config.chainId);
    this.txProviders = buildProviders(this.txUrls, config.chainId);

    if (config.enableTrading && config.mevProtectTx) {
      logger.info(
        {
          read: config.rpcUrls.map(maskRpcUrl),
          tx: config.txRpcUrls.map(maskRpcUrl),
        },
        "MEV-protected tx RPCs enabled (reads use public RPC_URLS)"
      );
    } else if (config.enableTrading && !config.mevProtectTx) {
      logger.warn(
        "MEV_PROTECT_TX=false — transactions use public RPC_URLS (visible in mempool)"
      );
    }
  }

  /** Public RPCs — reserves, gas quotes, simulations. */
  getReadProvider(): JsonRpcProvider {
    return this.readProviders[this.readIndex]!;
  }

  /** Private builder RPCs — broadcast only. */
  getTxProvider(): JsonRpcProvider {
    return this.txProviders[this.txIndex]!;
  }

  async withReadFallback<T>(fn: (provider: JsonRpcProvider) => Promise<T>): Promise<T> {
    return this.withFallbackOn(this.readProviders, "read", (i) => {
      this.readIndex = i;
    }, fn);
  }

  async withTxFallback<T>(fn: (provider: JsonRpcProvider) => Promise<T>): Promise<T> {
    return this.withFallbackOn(this.txProviders, "tx", (i) => {
      this.txIndex = i;
    }, fn);
  }

  /** @deprecated Use withReadFallback */
  async withFallback<T>(fn: (provider: JsonRpcProvider) => Promise<T>): Promise<T> {
    return this.withReadFallback(fn);
  }

  private async withFallbackOn<T>(
    providers: JsonRpcProvider[],
    label: string,
    setIndex: (i: number) => void,
    fn: (provider: JsonRpcProvider) => Promise<T>
  ): Promise<T> {
    const errors: Error[] = [];
    const start =
      label === "tx" ? this.txIndex : this.readIndex;
    for (let attempt = 0; attempt < providers.length; attempt++) {
      const idx = (start + attempt) % providers.length;
      const provider = providers[idx]!;
      try {
        const result = await fn(provider);
        setIndex(idx);
        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        errors.push(error);
        const urls = label === "tx" ? this.txUrls : this.readUrls;
        logger.warn(
          { rpc: label, index: idx, host: maskRpcUrl(urls[idx] ?? ""), err: error.message },
          "RPC failed, trying next"
        );
      }
    }
    throw new AggregateError(errors, `All ${label} RPC endpoints failed`);
  }

  async getBlockNumber(): Promise<number> {
    return this.withReadFallback((p) => p.getBlockNumber());
  }
}
