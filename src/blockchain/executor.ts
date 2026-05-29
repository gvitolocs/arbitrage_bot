import { Contract, Wallet, type JsonRpcProvider } from "ethers";
import { ERC20_ABI, UNISWAP_V2_ROUTER_ABI } from "../abis/index.js";
import type { BotConfig } from "../config.js";
import { fetchGasSnapshot, maxGasPriceWei } from "./gas.js";
import { applySlippageMin, getAmountOut } from "../dex/uniswapV2Math.js";
import { applyTxJitter } from "./mev.js";
import { logger } from "../logger.js";
import type { ProviderManager } from "./provider.js";

export interface SellWpknParams {
  amountWpkn: bigint;
  reserveWpkn: bigint;
  reserveQuote: bigint;
  feeBps: number;
  quoteTokenAddress: string;
}

export class SwapExecutor {
  private lastActionAt = 0;

  constructor(
    private readonly config: BotConfig,
    private readonly providerManager: ProviderManager
  ) {}

  private async getSigner(provider: JsonRpcProvider): Promise<Wallet> {
    const pk = this.config.privateKey!.startsWith("0x")
      ? this.config.privateKey!
      : `0x${this.config.privateKey!}`;
    const wallet = new Wallet(pk, provider);
    if (
      this.config.botWalletAddress &&
      wallet.address.toLowerCase() !== this.config.botWalletAddress.toLowerCase()
    ) {
      throw new Error("PRIVATE_KEY does not match BOT_WALLET_ADDRESS");
    }
    return wallet;
  }

  async sellWpknForQuote(params: SellWpknParams): Promise<string> {
    if (this.config.dryRun) {
      throw new Error("DRY_RUN=true");
    }
    if (!this.config.enableTrading) {
      throw new Error("ENABLE_TRADING=false");
    }
    if (!this.config.sellOnlyWpkn) {
      throw new Error("Only sell-only mode is enabled for this deployment");
    }
    if (!this.config.privateKey || !this.config.routerAddress) {
      throw new Error("PRIVATE_KEY and ROUTER_ADDRESS required");
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

    const path = [this.config.wpkenAddress, params.quoteTokenAddress];
    const expectedOut = getAmountOut(
      params.amountWpkn,
      params.reserveWpkn,
      params.reserveQuote,
      params.feeBps
    );
    const amountOutMin = applySlippageMin(expectedOut, this.config.maxSlippageBps);
    const deadline = Math.floor(Date.now() / 1000) + 120;

    return this.providerManager.withTxFallback(async (txProvider) => {
      const signer = await this.getSigner(txProvider);
      const wpken = new Contract(this.config.wpkenAddress, ERC20_ABI, signer);
      const router = new Contract(
        this.config.routerAddress!,
        UNISWAP_V2_ROUTER_ABI,
        signer
      );

      const swapArgs = [
        params.amountWpkn,
        amountOutMin,
        path,
        signer.address,
        deadline,
      ] as const;

      try {
        await router.swapExactTokensForTokens.staticCall(...swapArgs);
        logger.info("Preflight staticCall OK (private RPC)");
      } catch (err) {
        throw new Error(
          `Preflight simulation failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      const allowance = (await wpken.allowance(
        signer.address,
        this.config.routerAddress!
      )) as bigint;

      if (allowance < params.amountWpkn) {
        const approveAmount = this.config.unlimitedApproval
          ? 2n ** 256n - 1n
          : params.amountWpkn;
        logger.info({ amount: approveAmount.toString() }, "Approving router (private RPC)");
        const txA = await wpken.approve(this.config.routerAddress!, approveAmount, {
          gasPrice: gas.gasPriceWei,
        });
        await txA.wait();
      }

      const gasEstimate = await router.swapExactTokensForTokens.estimateGas(...swapArgs, {
        gasPrice: gas.gasPriceWei,
      });

      logger.info(
        {
          amountWpkn: params.amountWpkn.toString(),
          amountOutMin: amountOutMin.toString(),
          gasEstimate: gasEstimate.toString(),
          mevProtect: this.config.mevProtectTx,
        },
        "Broadcasting sell via MEV-protected RPC"
      );

      const tx = await router.swapExactTokensForTokens(...swapArgs, {
        gasLimit: (gasEstimate * 120n) / 100n,
        gasPrice: gas.gasPriceWei,
      });
      const receipt = await tx.wait();
      this.lastActionAt = Date.now() / 1000;
      return receipt!.hash as string;
    });
  }
}
