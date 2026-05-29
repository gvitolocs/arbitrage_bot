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
    this.ensureAlertColumns();
    this.db
      .prepare(`INSERT OR IGNORE INTO digest_state (id, last_digest_at) VALUES (1, NULL)`)
      .run();
    logger.info({ path: schemaPath }, "Database schema applied");
  }

  private ensureAlertColumns(): void {
    const cols = this.db
      .prepare(`PRAGMA table_info(alerts_sent)`)
      .all() as { name: string }[];
    const names = new Set(cols.map((c) => c.name));
    if (!names.has("instant")) {
      this.db.exec(`ALTER TABLE alerts_sent ADD COLUMN instant INTEGER NOT NULL DEFAULT 0`);
    }
    if (!names.has("digest_batch")) {
      this.db.exec(`ALTER TABLE alerts_sent ADD COLUMN digest_batch TEXT`);
    }
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

  saveAlert(alert: AlertPayload, instant = false): number {
    const info = this.db
      .prepare(
        `INSERT INTO alerts_sent (kind, title, message, pool_name, instant) VALUES (?, ?, ?, ?, ?)`
      )
      .run(alert.kind, alert.title, alert.message, alert.poolName ?? null, instant ? 1 : 0);
    return Number(info.lastInsertRowid);
  }

  hasRecentAlert(kind: string, message: string, withinMinutes: number): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM alerts_sent
         WHERE kind = ? AND message = ?
           AND datetime(created_at) > datetime('now', ?)
         LIMIT 1`
      )
      .get(kind, message, `-${withinMinutes} minutes`);
    return row != null;
  }

  getUndigestedAlerts(): Array<{
    id: number;
    kind: string;
    title: string;
    message: string;
    pool_name: string | null;
    created_at: string;
  }> {
    return this.db
      .prepare(
        `SELECT id, kind, title, message, pool_name, created_at FROM alerts_sent
         WHERE digest_batch IS NULL AND instant = 0
         ORDER BY created_at ASC`
      )
      .all() as Array<{
      id: number;
      kind: string;
      title: string;
      message: string;
      pool_name: string | null;
      created_at: string;
    }>;
  }

  markAlertsDigested(ids: number[], batchId: string): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(`UPDATE alerts_sent SET digest_batch = ? WHERE id = ?`);
    const tx = this.db.transaction((rows: number[]) => {
      for (const id of rows) stmt.run(batchId, id);
    });
    tx(ids);
  }

  getLastDigestAt(): string | null {
    const row = this.db
      .prepare(`SELECT last_digest_at FROM digest_state WHERE id = 1`)
      .get() as { last_digest_at: string | null } | undefined;
    return row?.last_digest_at ?? null;
  }

  setLastDigestAt(iso: string): void {
    this.db
      .prepare(`UPDATE digest_state SET last_digest_at = ? WHERE id = 1`)
      .run(iso);
  }

  getTransactionsSince(sinceIso: string): Array<{ kind: string; status: string; tx_hash: string | null }> {
    return this.db
      .prepare(
        `SELECT kind, status, tx_hash FROM transactions
         WHERE datetime(created_at) > datetime(?)
         ORDER BY created_at DESC`
      )
      .all(sinceIso) as Array<{ kind: string; status: string; tx_hash: string | null }>;
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
