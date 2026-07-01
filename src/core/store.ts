import { DatabaseSync } from "node:sqlite";
import { MAX_FACT_KEY_CHARS, MAX_FACT_VALUE_CHARS, MAX_SUPERSEDED } from "./defaults.js";

export type SupersededEntry = {
  value: string;
  channel?: string;
  sessionKey?: string;
  observedAt: number;
};

export type Fact = {
  agentId: string;
  factKey: string;
  value: string;
  importance: number;
  observedAt: number;
  channel?: string;
  sessionKey?: string;
  superseded: SupersededEntry[];
};

export type ExtractionOp = {
  factKey: string;
  value: string;
  importance: number;
  op: "ADD" | "UPDATE" | "NOOP";
};

export type ApplyContext = {
  agentId: string;
  observedAt: number;
  channel?: string;
  sessionKey?: string;
};

export type ApplyResult = "added" | "updated" | "noop";

type FactRow = {
  agent_id: string;
  fact_key: string;
  value: string;
  importance: number;
  observed_at: number;
  channel: string | null;
  session_key: string | null;
  superseded: string;
};

/**
 * Shared fact store (the blackboard). One SQLite file, rows scoped by agent_id. node:sqlite is
 * synchronous, so applyOp's CAS is one BEGIN IMMEDIATE transaction; WAL + busy_timeout only matter for
 * the separate CLI process, not within one gateway.
 */
export class FactStore {
  private readonly db: DatabaseSync;

  constructor(location: string) {
    this.db = new DatabaseSync(location);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS facts (
         agent_id    TEXT NOT NULL,
         fact_key    TEXT NOT NULL,
         value       TEXT NOT NULL,
         importance  REAL NOT NULL,
         observed_at INTEGER NOT NULL,
         channel     TEXT,
         session_key TEXT,
         superseded  TEXT NOT NULL DEFAULT '[]',
         PRIMARY KEY (agent_id, fact_key)
       );`,
    );
    // Index the (agent_id, observed_at) access path used by recent reads and TTL prunes.
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_facts_agent_observed ON facts (agent_id, observed_at);");
    // Index the importance-first key read used to build the extraction dedup list.
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_facts_agent_importance ON facts (agent_id, importance, observed_at);");
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS seen_messages (
         agent_id     TEXT NOT NULL,
         content_hash TEXT NOT NULL,
         observed_at  INTEGER NOT NULL,
         PRIMARY KEY (agent_id, content_hash)
       );`,
    );
  }

  hasSeen(agentId: string, contentHash: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM seen_messages WHERE agent_id = ? AND content_hash = ?")
      .get(agentId, contentHash);
    return row !== undefined;
  }

  markSeen(agentId: string, contentHash: string, observedAt: number): void {
    this.db
      .prepare("INSERT OR IGNORE INTO seen_messages (agent_id, content_hash, observed_at) VALUES (?, ?, ?)")
      .run(agentId, contentHash, observedAt);
  }

  /** Release a claim so a genuine retry can re-extract after a failed extraction. */
  unmarkSeen(agentId: string, contentHash: string): void {
    this.db
      .prepare("DELETE FROM seen_messages WHERE agent_id = ? AND content_hash = ?")
      .run(agentId, contentHash);
  }

  getRecentFacts(agentId: string, limit: number): Fact[] {
    const rows = this.db
      .prepare("SELECT * FROM facts WHERE agent_id = ? ORDER BY observed_at DESC LIMIT ?")
      .all(agentId, limit) as FactRow[];
    return rows.map(rowToFact);
  }

  // Importance-first, bounded keys so the extraction dedup list does not grow without limit as the store fills.
  listFactKeys(agentId: string, limit: number): string[] {
    const rows = this.db
      .prepare("SELECT fact_key FROM facts WHERE agent_id = ? ORDER BY importance DESC, observed_at DESC LIMIT ?")
      .all(agentId, limit) as { fact_key: string }[];
    return rows.map((row) => row.fact_key);
  }

  // Whole live set (TTL-bounded) so inject can rank by recency x importance without a cap that would
  // starve recent low-importance facts.
  readRankingCandidates(agentId: string): Fact[] {
    const rows = this.db.prepare("SELECT * FROM facts WHERE agent_id = ?").all(agentId) as FactRow[];
    return rows.map(rowToFact);
  }

  readAllForAgent(agentId: string): Fact[] {
    const rows = this.db.prepare("SELECT * FROM facts WHERE agent_id = ?").all(agentId) as FactRow[];
    return rows.map(rowToFact);
  }

  // Conflict resolution as an atomic CAS: overwrite only when observedAt is strictly newer, keeping the
  // prior value in superseded[]. Identical key+value is a no-op. One synchronous transaction.
  applyOp(op: ExtractionOp, ctx: ApplyContext): ApplyResult {
    if (op.op === "NOOP") return "noop";
    const key = op.factKey.trim().slice(0, MAX_FACT_KEY_CHARS);
    const value = op.value.trim().slice(0, MAX_FACT_VALUE_CHARS);
    if (!key || !value) return "noop";

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare("SELECT * FROM facts WHERE agent_id = ? AND fact_key = ?")
        .get(ctx.agentId, key) as FactRow | undefined;

      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO facts (agent_id, fact_key, value, importance, observed_at, channel, session_key, superseded)
             VALUES (?, ?, ?, ?, ?, ?, ?, '[]')`,
          )
          .run(ctx.agentId, key, value, op.importance, ctx.observedAt, ctx.channel ?? null, ctx.sessionKey ?? null);
        this.db.exec("COMMIT");
        return "added";
      }

      if (ctx.observedAt <= existing.observed_at) {
        this.db.exec("COMMIT");
        return "noop";
      }
      if (existing.value === value) {
        this.db.exec("COMMIT");
        return "noop";
      }

      const priorTrail = parseSuperseded(existing.superseded);
      const nextTrail: SupersededEntry[] = [
        {
          value: existing.value,
          channel: existing.channel ?? undefined,
          sessionKey: existing.session_key ?? undefined,
          observedAt: existing.observed_at,
        },
        ...priorTrail,
      ].slice(0, MAX_SUPERSEDED);

      this.db
        .prepare(
          `UPDATE facts
              SET value = ?, importance = ?, observed_at = ?, channel = ?, session_key = ?, superseded = ?
            WHERE agent_id = ? AND fact_key = ?`,
        )
        .run(
          value,
          op.importance,
          ctx.observedAt,
          ctx.channel ?? null,
          ctx.sessionKey ?? null,
          JSON.stringify(nextTrail),
          ctx.agentId,
          key,
        );
      this.db.exec("COMMIT");
      return "updated";
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // Drop this agent's facts and seen rows older than the cutoff.
  pruneExpired(agentId: string, cutoff: number): void {
    this.db.prepare("DELETE FROM facts WHERE agent_id = ? AND observed_at < ?").run(agentId, cutoff);
    this.db.prepare("DELETE FROM seen_messages WHERE agent_id = ? AND observed_at < ?").run(agentId, cutoff);
  }
}

function rowToFact(row: FactRow): Fact {
  return {
    agentId: row.agent_id,
    factKey: row.fact_key,
    value: row.value,
    importance: row.importance,
    observedAt: row.observed_at,
    channel: row.channel ?? undefined,
    sessionKey: row.session_key ?? undefined,
    superseded: parseSuperseded(row.superseded),
  };
}

function parseSuperseded(raw: string): SupersededEntry[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SupersededEntry[]) : [];
  } catch {
    return [];
  }
}
