import { Contract, Wallet, type JsonRpcProvider } from "ethers";
import { ERC20_ABI } from "../abis/index.js";
import type { BotConfig } from "../config.js";
import { applySlippageMin } from "../dex/uniswapV2Math.js";
import type { PoolKey } from "../dex/uniswapV4Pool.js";
import { encodeWpknToNativeV4Swap } from "./uniswapV4Encode.js";
import { fetchGasSnapshot, maxGasPriceWei } from "./gas.js";
import { applyTxJitter } from "./mev.js";
import { logger } from "../logger.js";
import type { ProviderManager } from "./provider.js";

const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

const PERMIT2_ABI = [
  "function approve(address token, address spender, uint160 amount, uint48 expiration) external",
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
] as const;

export interface SellWpknV4Params {
  amountWpkn: bigint;
  poolKey: PoolKey;
  expectedNativeOut: bigint;
}

export class UniswapV4Executor {
  private lastActionAt = 0;

  constructor(
    private readonly config: BotConfig,
    private readonly providerManager: ProviderManager
  ) {}

  private routerAddress(): string {
    return this.config.uniswapUniversalRouter!;
  }

  private async getSigner(provider: JsonRpcProvider): Promise<Wallet> {
    const pk = this.config.privateKey!.startsWith("0x")
      ? this.config.privateKey!
      : `0x${this.config.privateKey!}`;
    return new Wallet(pk, provider);
  }

  private async ensurePermit2(
    signer: Wallet,
    amount: bigint,
    gasPriceWei: bigint
  ): Promise<void> {
    const tokenAddress = this.config.wpkenAddress;
    const wpken = new Contract(tokenAddress, ERC20_ABI, signer);
    const permit2 = new Contract(PERMIT2, PERMIT2_ABI, signer);
    const router = this.routerAddress();

    const ercAllowance = (await wpken.allowance(signer.address, PERMIT2)) as bigint;
    if (ercAllowance < amount) {
      const approveAmount = this.config.unlimitedApproval ? 2n ** 256n - 1n : amount;
      logger.info("Approving Permit2 for wPKN");
      const tx = await wpken.approve(PERMIT2, approveAmount, { gasPrice: gasPriceWei });
      await tx.wait();
    }

    const [p2Amount] = (await permit2.allowance(
      signer.address,
      tokenAddress,
      router
    )) as [bigint, bigint, bigint];
    if (p2Amount < amount) {
      const expiration = Math.floor(Date.now() / 1000) + 86_400 * 30;
      logger.info("Permit2 → Universal Router allowance");
      const tx = await permit2.approve(
        tokenAddress,
        router,
        this.config.unlimitedApproval ? 2n ** 160n - 1n : amount,
        expiration,
        { gasPrice: gasPriceWei }
      );
      await tx.wait();
    }
  }

  buildSellCalldata(params: SellWpknV4Params, recipient: string) {
    const amountOutMin = applySlippageMin(
      params.expectedNativeOut,
      this.config.maxSlippageBps
    );
    return encodeWpknToNativeV4Swap({
      chainId: this.config.chainId,
      wpkenAddress: this.config.wpkenAddress,
      recipient,
      amountWpkn: params.amountWpkn,
      expectedNativeOut: params.expectedNativeOut,
      amountOutMin,
      maxSlippageBps: this.config.maxSlippageBps,
      poolKey: params.poolKey,
    });
  }

  async sellWpknForNative(params: SellWpknV4Params): Promise<string> {
    if (this.config.dryRun) throw new Error("DRY_RUN=true");
    if (!this.config.enableTrading) throw new Error("ENABLE_TRADING=false");
    if (!this.config.privateKey) throw new Error("PRIVATE_KEY required");
    if (!this.config.uniswapUniversalRouter) {
      throw new Error("UNISWAP_UNIVERSAL_ROUTER not configured");
    }

    const elapsed = Date.now() / 1000 - this.lastActionAt;
    if (elapsed < this.config.minSecondsBetweenActions) {
      throw new Error(`Cooldown: wait ${this.config.minSecondsBetweenActions - elapsed}s`);
    }

    await applyTxJitter(this.config.txJitterMs);

    const gas = await this.providerManager.withReadFallback((p) =>
      fetchGasSnapshot(p, this.config)
    );
    if (!gas.withinLimit || gas.gasPriceWei > maxGasPriceWei(this.config)) {
      throw new Error(`Gas ${gas.gasPriceGwei.toFixed(2)} gwei above cap`);
    }

    return this.providerManager.withTxFallback(async (txProvider) => {
      const signer = await this.getSigner(txProvider);
      await this.ensurePermit2(signer, params.amountWpkn, gas.gasPriceWei);

      const { calldata, value } = this.buildSellCalldata(params, signer.address);
      const txValue = BigInt(value);

      try {
        await signer.call({ to: this.routerAddress(), data: calldata, value: txValue });
        logger.info("Uniswap v4 sell eth_call OK");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Uniswap v4 preflight failed (no executable v4 depth — add in-range BNB+wPKN LP): ${msg}`
        );
      }

      const gasEstimate = await signer.estimateGas({
        to: this.routerAddress(),
        data: calldata,
        value: txValue,
      });

      logger.info(
        {
          amountWpkn: params.amountWpkn.toString(),
          expectedNativeOut: params.expectedNativeOut.toString(),
          router: this.routerAddress(),
        },
        "Broadcasting Uniswap v4 sell"
      );

      const tx = await signer.sendTransaction({
        to: this.routerAddress(),
        data: calldata,
        value: txValue,
        gasLimit: (gasEstimate * 130n) / 100n,
        gasPrice: gas.gasPriceWei,
      });
      const receipt = await tx.wait();
      this.lastActionAt = Date.now() / 1000;
      return receipt!.hash as string;
    });
  }
}
