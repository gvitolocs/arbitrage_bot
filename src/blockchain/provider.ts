import { JsonRpcProvider, Network } from "ethers";
import type { BotConfig } from "../config.js";
import { logger } from "../logger.js";

export class ProviderManager {
  private providers: JsonRpcProvider[];
  private currentIndex = 0;

  constructor(private readonly config: BotConfig) {
    const network = Network.from(config.chainId);
    this.providers = config.rpcUrls.map(
      (url) =>
        new JsonRpcProvider(url, network, {
          staticNetwork: network,
          batchMaxCount: 1,
        })
    );
  }

  getProvider(): JsonRpcProvider {
    return this.providers[this.currentIndex]!;
  }

  async withFallback<T>(fn: (provider: JsonRpcProvider) => Promise<T>): Promise<T> {
    const errors: Error[] = [];
    for (let attempt = 0; attempt < this.providers.length; attempt++) {
      const idx = (this.currentIndex + attempt) % this.providers.length;
      const provider = this.providers[idx]!;
      try {
        const result = await fn(provider);
        this.currentIndex = idx;
        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        errors.push(error);
        logger.warn({ rpcIndex: idx, err: error.message }, "RPC call failed, trying next");
      }
    }
    throw new AggregateError(errors, "All RPC endpoints failed");
  }

  async getBlockNumber(): Promise<number> {
    return this.withFallback((p) => p.getBlockNumber());
  }
}
