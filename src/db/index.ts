import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AlertPayload, ArbitrageSimulationResult, PoolReserves } from "../types.js";
import { logger } from "../logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export class BotDatabase {
  private db: Database.Database;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    const candidates = [
      join(__dirname, "schema.sql"),
      join(process.cwd(), "dist/db/schema.sql"),
      join(process.cwd(), "src/db/schema.sql"),
    ];
    const schemaPath = candidates.find((p) => existsSync(p));
    if (!schemaPath) {
      throw new Error("schema.sql not found");
    }
    const sql = readFileSync(schemaPath, "utf8");
    this.db.exec(sql);
    logger.info({ path: schemaPath }, "Database schema applied");
  }

  saveReserveSnapshot(reserves: PoolReserves, priceQuotePerWpkn: number): void {
    const stmt = this.db.prepare(`
      INSERT INTO reserve_snapshots
        (pool_address, pool_name, block_number, wpkn_reserve, quote_reserve, quote_symbol, price_quote_per_wpkn)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      reserves.poolAddress,
      reserves.poolName,
      reserves.blockNumber,
      reserves.wpknReserve.toString(),
      reserves.quoteReserve.toString(),
      reserves.quoteToken.symbol,
      priceQuotePerWpkn
    );
  }

  saveOpportunity(kind: string, result: ArbitrageSimulationResult): void {
    this.db
      .prepare(
        `INSERT INTO opportunities (kind, profitable, details_json) VALUES (?, ?, ?)`
      )
      .run(kind, result.profitable ? 1 : 0, JSON.stringify(result));
  }

  saveAlert(alert: AlertPayload): number {
    const info = this.db
      .prepare(
        `INSERT INTO alerts_sent (kind, title, message, pool_name) VALUES (?, ?, ?, ?)`
      )
      .run(alert.kind, alert.title, alert.message, alert.poolName ?? null);
    return Number(info.lastInsertRowid);
  }

  recordTransaction(
    kind: string,
    status: string,
    details: Record<string, unknown>,
    txHash?: string,
    gasUsed?: bigint
  ): void {
    this.db
      .prepare(
        `INSERT INTO transactions (tx_hash, kind, status, details_json, gas_used) VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        txHash ?? null,
        kind,
        status,
        JSON.stringify(details),
        gasUsed?.toString() ?? null
      );
  }

  getDailyUsage(date: string): { wpkenRefilled: bigint; wbnbSpent: bigint } {
    const row = this.db
      .prepare(`SELECT wpkn_refilled, wbnb_spent FROM daily_usage WHERE date = ?`)
      .get(date) as { wpkn_refilled: string; wbnb_spent: string } | undefined;

    if (!row) {
      return { wpkenRefilled: 0n, wbnbSpent: 0n };
    }
    return {
      wpkenRefilled: BigInt(row.wpkn_refilled),
      wbnbSpent: BigInt(row.wbnb_spent),
    };
  }

  addDailyUsage(date: string, wpken: bigint, wbnb: bigint): void {
    const current = this.getDailyUsage(date);
    this.db
      .prepare(
        `INSERT INTO daily_usage (date, wpkn_refilled, wbnb_spent)
         VALUES (?, ?, ?)
         ON CONFLICT(date) DO UPDATE SET
           wpkn_refilled = excluded.wpkn_refilled,
           wbnb_spent = excluded.wbnb_spent`
      )
      .run(
        date,
        (current.wpkenRefilled + wpken).toString(),
        (current.wbnbSpent + wbnb).toString()
      );
  }

  updatePoolState(poolAddress: string, block: number, wpknReserve: bigint): void {
    this.db
      .prepare(
        `INSERT INTO pool_state (pool_address, last_block, last_reserve_wpkn, last_updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(pool_address) DO UPDATE SET
           last_block = excluded.last_block,
           last_reserve_wpkn = excluded.last_reserve_wpkn,
           last_updated_at = excluded.last_updated_at`
      )
      .run(poolAddress, block, wpknReserve.toString());
  }

  getPoolState(poolAddress: string): { lastBlock: number; lastReserveWpkn: bigint } | null {
    const row = this.db
      .prepare(`SELECT last_block, last_reserve_wpkn FROM pool_state WHERE pool_address = ?`)
      .get(poolAddress) as { last_block: number; last_reserve_wpkn: string } | undefined;
    if (!row) return null;
    return { lastBlock: row.last_block, lastReserveWpkn: BigInt(row.last_reserve_wpkn) };
  }

  close(): void {
    this.db.close();
  }
}
