# Security

## Wallet model

- Use a **dedicated hot wallet** with limited BNB and wPKN only.
- Never use treasury, deployer, or main holdings wallet.
- Set `TREASURY_ADDRESSES` so the bot refuses to start if `BOT_WALLET_ADDRESS` matches.

## Secrets

- `PRIVATE_KEY` only via environment / `.env` (never commit).
- Logs redact `PRIVATE_KEY` and `TELEGRAM_BOT_TOKEN` (see `logger.ts`).
- Do not log full `.env` or RPC URLs with embedded keys.

## Default-safe configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `DRY_RUN` | `true` | Blocks all transactions |
| `ENABLE_TRADING` | `false` | Swaps disabled |
| `ENABLE_AUTO_LIQUIDITY` | `false` | addLiquidity disabled |
| `UNLIMITED_APPROVAL` | `false` | Prefer exact approvals |

Startup fails if `ENABLE_TRADING` or `ENABLE_AUTO_LIQUIDITY` is true while `DRY_RUN=true`.

## Spending limits

- Per-tx and per-day caps: `MAX_WPKN_REFILL_*`, `MAX_WBNB_SPEND_*`
- `MAX_GAS_PRICE_GWEI`
- `MIN_SECONDS_BETWEEN_ACTIONS`
- `MAX_SLIPPAGE_BPS` for min output calculations (execution milestone)

## Execution checklist (milestone 2)

Before any on-chain transaction:

1. `DRY_RUN=false`
2. Feature flag (`ENABLE_TRADING` or `ENABLE_AUTO_LIQUIDITY`)
3. Gas ≤ `MAX_GAS_PRICE_GWEI`
4. Daily limits (SQLite `daily_usage`)
5. Wallet balances
6. `eth_call` / router simulation
7. Gas estimate
8. Slippage-adjusted minimum output
9. Send tx → wait → persist → Telegram

## Approvals

- Default: approve exact amount per refill/swap.
- `UNLIMITED_APPROVAL=true` only if you accept elevated rug/drain risk.

## Known limitations (v0.1)

- **Live transaction execution is not implemented.** Monitoring and simulation only.
- Verify pool pair addresses and that `wPKN/BNB` pools use WBNB internally (`token0`/`token1` read).

## Reporting

If you find a vulnerability, do not open a public issue with exploit details; contact the repository owner privately.
