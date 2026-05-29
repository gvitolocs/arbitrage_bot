import "dotenv/config";
import { getAddress, isAddress } from "ethers";
import { BSC_FREE_MEV_TX_RPCS } from "./blockchain/mev.js";
import type { PoolConfig } from "./types.js";

export interface BotConfig {
  rpcUrls: string[];
  /** Private / MEV-protected endpoints — used only to broadcast transactions. */
  txRpcUrls: string[];
  mevProtectTx: boolean;
  txJitterMs: number;
  chainId: number;
  privateKey: string | undefined;
  botWalletAddress: string | undefined;
  treasuryAddresses: string[];
  wpkenAddress: string;
  wbnbAddress: string;
  routerAddress: string | undefined;
  pools: PoolConfig[];
  dryRun: boolean;
  enableTrading: boolean;
  enableAutoLiquidity: boolean;
  minWpkenReservePerPool: bigint;
  priceDiffAlertPercent: number;
  arbitrageMinProfitBnb: number;
  maxSlippageBps: number;
  maxGasPriceGwei: number;
  pollIntervalSeconds: number;
  minSecondsBetweenActions: number;
  maxWpkenRefillPerTx: bigint;
  maxWpkenRefillPerDay: bigint;
  maxWbnbSpendPerTx: bigint;
  maxWbnbSpendPerDay: bigint;
  defaultPoolFeeBps: number;
  hermesAlertUrl: string | undefined;
  hermesAlertToken: string | undefined;
  databasePath: string;
  healthPort: number;
  stalePoolSeconds: number;
  requireManualConfirmation: boolean;
  unlimitedApproval: boolean;
  sellOnlyWpkn: boolean;
  maxWpknSellPerTx: bigint;
  maxWpknSellPerDay: bigint;
  geckoNetwork: string;
}

function requireAddress(name: string, value: string | undefined): string {
  if (!value?.trim()) {
    throw new Error(`Missing required address: ${name}`);
  }
  if (!isAddress(value)) {
    throw new Error(`Invalid address for ${name}: ${value}`);
  }
  return getAddress(value);
}

function optionalAddress(name: string, value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  if (!isAddress(value)) {
    throw new Error(`Invalid address for ${name}: ${value}`);
  }
  return getAddress(value);
}

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === "") return defaultValue;
  return value.toLowerCase() === "true" || value === "1";
}

function parseTokenAmount(value: string | undefined, defaultStr: string, decimals = 18): bigint {
  const v = value?.trim() || defaultStr;
  const [whole, frac = ""] = v.split(".");
  const fracPadded = frac.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fracPadded || "0");
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function parseRpcUrls(raw: string | undefined): string[] {
  const urls = (raw ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  if (urls.length === 0) {
    throw new Error("RPC_URLS must contain at least one URL");
  }
  return urls;
}

function parsePools(): PoolConfig[] {
  const pools: PoolConfig[] = [];
  const feeDefault = Number(process.env.POOL_FEE_BPS ?? "25");

  const add = (
    addrEnv: string,
    nameEnv: string,
    feeEnv?: string,
    kindEnv?: string
  ) => {
    const addr = process.env[addrEnv]?.trim();
    if (!addr) return;
    const kindRaw = (kindEnv && process.env[kindEnv]) || "v2";
    const kind = kindRaw.toLowerCase() === "gecko" ? "gecko" : "v2";
    pools.push({
      address: kind === "v2" ? getAddress(addr) : addr.toLowerCase(),
      name: process.env[nameEnv]?.trim() || addrEnv,
      feeBps: feeEnv && process.env[feeEnv] ? Number(process.env[feeEnv]) : feeDefault,
      kind,
    });
  };

  add("POOL_A_ADDRESS", "POOL_A_NAME", "POOL_A_FEE_BPS", "POOL_A_KIND");
  add("POOL_B_ADDRESS", "POOL_B_NAME", "POOL_B_FEE_BPS", "POOL_B_KIND");

  if (pools.length < 1) {
    throw new Error("Configure at least one pool (POOL_A_ADDRESS)");
  }
  return pools;
}

export function loadConfig(): BotConfig {
  const botWallet = optionalAddress("BOT_WALLET_ADDRESS", process.env.BOT_WALLET_ADDRESS);
  const privateKey = process.env.PRIVATE_KEY?.trim() || undefined;

  if (!parseBool(process.env.DRY_RUN, true) && privateKey && !botWallet) {
    throw new Error("BOT_WALLET_ADDRESS required when PRIVATE_KEY is set and DRY_RUN=false");
  }

  const treasuryRaw = process.env.TREASURY_ADDRESSES ?? process.env.MAIN_WALLET_ADDRESS ?? "";
  const treasuryAddresses = treasuryRaw
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean)
    .map((a) => getAddress(a));

  if (botWallet && treasuryAddresses.some((t) => t.toLowerCase() === botWallet.toLowerCase())) {
    throw new Error("BOT_WALLET_ADDRESS must not match a configured treasury/main wallet");
  }

  const enableTrading = parseBool(process.env.ENABLE_TRADING, false);
  const enableAutoLiquidity = parseBool(process.env.ENABLE_AUTO_LIQUIDITY, false);
  const sellOnlyWpkn = parseBool(process.env.SELL_ONLY_WPKN, true);
  const dryRun = parseBool(process.env.DRY_RUN, true);
  const mevProtectTx = parseBool(process.env.MEV_PROTECT_TX, true);

  const txRpcRaw = process.env.TX_RPC_URLS?.trim();
  let txRpcUrls = txRpcRaw
    ? txRpcRaw.split(",").map((u) => u.trim()).filter(Boolean)
    : [];
  if (mevProtectTx && txRpcUrls.length === 0) {
    txRpcUrls = [...BSC_FREE_MEV_TX_RPCS];
  }
  if (enableTrading && mevProtectTx && txRpcUrls.length === 0) {
    throw new Error("TX_RPC_URLS required when MEV_PROTECT_TX=true and trading enabled");
  }

  if ((enableTrading || enableAutoLiquidity) && dryRun) {
    throw new Error("Cannot enable trading/liquidity while DRY_RUN=true");
  }
  if ((enableTrading || enableAutoLiquidity) && !privateKey) {
    throw new Error("PRIVATE_KEY required when trading or auto-liquidity is enabled");
  }
  if (enableAutoLiquidity && sellOnlyWpkn) {
    throw new Error("ENABLE_AUTO_LIQUIDITY conflicts with SELL_ONLY_WPKN");
  }
  if (enableTrading && mevProtectTx) {
    const publicHosts = new Set(parseRpcUrls(process.env.RPC_URLS).map(hostOf));
    const overlap = txRpcUrls.filter((u) => publicHosts.has(hostOf(u)));
    if (overlap.length === txRpcUrls.length && txRpcUrls.length > 0) {
      throw new Error(
        "TX_RPC_URLS must use private MEV RPCs (e.g. bscrpc.pancakeswap.finance), not only public seeds"
      );
    }
  }

  const config: BotConfig = {
    rpcUrls: parseRpcUrls(process.env.RPC_URLS),
    txRpcUrls: txRpcUrls.length > 0 ? txRpcUrls : parseRpcUrls(process.env.RPC_URLS),
    mevProtectTx,
    txJitterMs: Number(process.env.TX_JITTER_MS ?? "3000"),
    chainId: Number(process.env.CHAIN_ID ?? "56"),
    privateKey,
    botWalletAddress: botWallet,
    treasuryAddresses,
    wpkenAddress: requireAddress("WPKN_ADDRESS", process.env.WPKN_ADDRESS),
    wbnbAddress: requireAddress(
      "WBNB_ADDRESS",
      process.env.WBNB_ADDRESS ?? "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"
    ),
    routerAddress:
      optionalAddress("ROUTER_ADDRESS", process.env.ROUTER_ADDRESS) ??
      (enableTrading
        ? getAddress("0x10ED43C718714eb63d5aA57B78B54704E256024E")
        : undefined),
    pools: parsePools(),
    dryRun,
    enableTrading,
    enableAutoLiquidity,
    minWpkenReservePerPool: parseTokenAmount(process.env.MIN_WPKN_RESERVE_PER_POOL, "50"),
    priceDiffAlertPercent: Number(process.env.PRICE_DIFF_ALERT_PERCENT ?? "10"),
    arbitrageMinProfitBnb: Number(process.env.ARBITRAGE_MIN_PROFIT_BNB ?? "0.001"),
    maxSlippageBps: Number(process.env.MAX_SLIPPAGE_BPS ?? "100"),
    maxGasPriceGwei: Number(process.env.MAX_GAS_PRICE_GWEI ?? "3"),
    pollIntervalSeconds: Number(process.env.POLL_INTERVAL_SECONDS ?? "30"),
    minSecondsBetweenActions: Number(process.env.MIN_SECONDS_BETWEEN_ACTIONS ?? "300"),
    maxWpkenRefillPerTx: parseTokenAmount(process.env.MAX_WPKN_REFILL_PER_TX, "50"),
    maxWpkenRefillPerDay: parseTokenAmount(process.env.MAX_WPKN_REFILL_PER_DAY, "200"),
    maxWbnbSpendPerTx: parseTokenAmount(process.env.MAX_WBNB_SPEND_PER_TX, "0.01"),
    maxWbnbSpendPerDay: parseTokenAmount(process.env.MAX_WBNB_SPEND_PER_DAY, "0.05"),
    defaultPoolFeeBps: Number(process.env.POOL_FEE_BPS ?? "25"),
    hermesAlertUrl: process.env.HERMES_ALERT_URL?.trim() || undefined,
    hermesAlertToken:
      process.env.HERMES_ALERT_TOKEN?.trim() ||
      process.env.BOT_HOSPITAL_TOKEN?.trim() ||
      undefined,
    databasePath: process.env.DATABASE_PATH ?? "./data/bot.sqlite",
    healthPort: Number(process.env.HEALTH_PORT ?? "8080"),
    stalePoolSeconds: Number(process.env.STALE_POOL_SECONDS ?? "3600"),
    requireManualConfirmation: parseBool(process.env.REQUIRE_MANUAL_CONFIRMATION, true),
    unlimitedApproval: parseBool(process.env.UNLIMITED_APPROVAL, false),
    sellOnlyWpkn,
    maxWpknSellPerTx: parseTokenAmount(process.env.MAX_WPKN_SELL_PER_TX, "5"),
    maxWpknSellPerDay: parseTokenAmount(process.env.MAX_WPKN_SELL_PER_DAY, "50"),
    geckoNetwork: process.env.GECKO_NETWORK ?? "bsc",
  };

  if (config.enableTrading && !config.routerAddress) {
    throw new Error("ROUTER_ADDRESS required when ENABLE_TRADING=true");
  }

  return config;
}

export function formatConfigSummary(config: BotConfig): string {
  return [
    `chainId=${config.chainId}`,
    `dryRun=${config.dryRun}`,
    `enableTrading=${config.enableTrading}`,
    `enableAutoLiquidity=${config.enableAutoLiquidity}`,
    `sellOnly=${config.sellOnlyWpkn}`,
    `mevTx=${config.mevProtectTx}`,
    `txRpcs=${config.txRpcUrls.length}`,
    `pools=${config.pools.map((p) => p.name).join(", ")}`,
    `pollInterval=${config.pollIntervalSeconds}s`,
  ].join(" | ");
}
