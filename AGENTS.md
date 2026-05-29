# Multi-agent development map

This document defines module ownership so parallel agents do not conflict.

## Milestone 1 (current): read-only + dry-run

- No live `swap` / `addLiquidity` (see `TransactionExecutor` in `src/blockchain/contracts.ts`).
- `DRY_RUN=true`, `ENABLE_TRADING=false`, `ENABLE_AUTO_LIQUIDITY=false` by default.

## Agent ownership

| Agent | Owns | Do not edit without coordination |
|-------|------|----------------------------------|
| **1 — Blockchain Core** | `src/blockchain/*` | `types.ts` interfaces `IPoolReader`, `ITransactionExecutor` |
| **2 — DEX Math** | `src/dex/uniswapV2Math.ts`, `tests/uniswapV2Math.test.ts` | Pure functions only; no I/O |
| **3 — Monitoring** | `src/services/poolMonitor.ts`, `arbitrageSimulator.ts`, `liquidityGuardian.ts` | Uses types from `types.ts`; calls math + blockchain readers only |
| **4 — Persistence** | `src/db/*`, `src/logger.ts` | Schema changes require migration note |
| **5 — Telegram/Ops** | `src/services/telegram.ts`, health in `index.ts` | Alert shape `AlertPayload` in `types.ts` |
| **6 — DevOps** | `Dockerfile`, `docker-compose.yml`, `scripts/*`, `systemd/*`, `README.md` | |
| **7 — Security** | `SECURITY.md`, config guards in `config.ts` | Reviews `TransactionExecutor` before milestone 2 |

## Shared contracts (`src/types.ts`)

All agents import domain types from here. Changing interfaces requires updating all consumers.

## Milestone 2 (future): execution

1. Implement `TransactionExecutor` with full safety checklist.
2. Wire `liquidityGuardian` execution path.
3. Security agent sign-off before `ENABLE_*` defaults change.

## Sequence

1. Skeleton + interfaces ✅  
2. Config validation ✅  
3. Read-only monitoring ✅  
4. Telegram + SQLite ✅  
5. Arbitrage simulation ✅  
6. Refill planning only ✅  
7. Docker + docs ✅  
8. Execution behind flags (not started)  
9. Security review (`SECURITY.md`) ✅ initial  
