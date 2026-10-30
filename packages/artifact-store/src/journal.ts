import { DatabaseSync } from "node:sqlite";
import { chmod, lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { hashJson, stableJson } from "../../contracts/src/index.js";
import { RepositoryFiles } from "./repository.js";

/** Local transactional state. Immutable evidence stays outside the database. */
export class OperationJournal {
  private constructor(private readonly db: DatabaseSync) {}

  static async open(root: string): Promise<OperationJournal> {
    const directory = await new RepositoryFiles(root).directory(".basalt-evals/journal");
    const file = resolve(directory, "operations.sqlite");
    const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error("Unsafe journal file");
    const db = new DatabaseSync(file);
    try {
      await chmod(file, 0o600);
      db.exec(
        "PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA fullfsync=ON; PRAGMA foreign_keys=ON;",
      );
      const expected: Record<string, unknown> = {
        journal_mode: "delete",
        synchronous: 3,
        fullfsync: 1,
        foreign_keys: 1,
      };
      for (const [name, value] of Object.entries(expected)) {
        const row = db.prepare(`PRAGMA ${name}`).get();
        if (!row || Object.values(row)[0] !== value)
          throw new Error(`Required SQLite setting unavailable: ${name}`);
      }
      db.exec(`CREATE TABLE IF NOT EXISTS records (
        namespace TEXT NOT NULL, identity TEXT NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY (namespace, identity)
      ) STRICT;`);
      db.exec(`CREATE TABLE IF NOT EXISTS projections (
        namespace TEXT NOT NULL, identity TEXT NOT NULL, search TEXT NOT NULL,
        status TEXT NOT NULL, sort TEXT NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY (namespace, identity)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS projection_order ON projections(namespace, sort, identity);
      CREATE INDEX IF NOT EXISTS projection_filter ON projections(namespace, status, sort, identity);
      CREATE INDEX IF NOT EXISTS projection_state ON projections(namespace, json_extract(body, '$.state'), sort, identity);
      CREATE INDEX IF NOT EXISTS projection_operation ON projections(namespace, json_extract(body, '$.operationId'), sort, identity);`);
      db.exec(`CREATE TABLE IF NOT EXISTS operational_issues (
        operation TEXT NOT NULL, code TEXT NOT NULL, dependency TEXT NOT NULL,
        explanation TEXT NOT NULL, captures INTEGER NOT NULL, candidates INTEGER NOT NULL, action TEXT NOT NULL, group_id TEXT NOT NULL,
        PRIMARY KEY(operation, code, dependency)
      ) STRICT; CREATE INDEX IF NOT EXISTS issue_groups ON operational_issues(code, dependency);`);
      return new OperationJournal(db);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  read<T>(namespace: string, identity: string): T | null {
    const row = this.db
      .prepare("SELECT body FROM records WHERE namespace=? AND identity=?")
      .get(namespace, identity);
    return row ? (JSON.parse(row.body as string) as T) : null;
  }

  put(namespace: string, identity: string, body: unknown): void {
    this.db
      .prepare(
        "INSERT INTO records VALUES (?, ?, ?) ON CONFLICT(namespace, identity) DO UPDATE SET body=excluded.body",
      )
      .run(namespace, identity, stableJson(body));
  }

  remove(namespace: string, identity: string): void {
    this.db
      .prepare("DELETE FROM records WHERE namespace=? AND identity=?")
      .run(namespace, identity);
  }

  /** Remove the records of one namespace whose identity starts with the prefix. */
  removePrefix(namespace: string, prefix: string): void {
    if (!prefix) throw new Error("A record prefix is necessary");
    this.db
      .prepare("DELETE FROM records WHERE namespace=? AND substr(identity, 1, ?)=?")
      .run(namespace, prefix.length, prefix);
  }

  removeProjection(namespace: string, identity: string): void {
    this.db
      .prepare("DELETE FROM projections WHERE namespace=? AND identity=?")
      .run(namespace, identity);
  }

  /** Remove the projection rows of one namespace that name one operation in their body. */
  removeOperationProjections(namespace: string, operationId: string): void {
    this.db
      .prepare(
        "DELETE FROM projections WHERE namespace=? AND json_extract(body, '$.operationId')=?",
      )
      .run(namespace, operationId);
  }

  /** The records whose identity is the owner or starts with "<owner>:". */
  recordsKeyedBy(owner: string): Array<{ namespace: string; id: string }> {
    if (!owner) throw new Error("A record owner is necessary");
    return this.db
      .prepare(
        "SELECT namespace, identity FROM records WHERE identity=? OR substr(identity, 1, ?)=? ORDER BY namespace, identity LIMIT 10001",
      )
      .all(owner, owner.length + 1, `${owner}:`)
      .map((row) => ({ namespace: String(row.namespace), id: String(row.identity) }));
  }

  /** A bounded maintenance scan: the records whose stored body contains the exact text. */
  recordsContaining(text: string, limit = 200): Array<{ namespace: string; id: string }> {
    if (!text) throw new Error("A search text is necessary");
    return this.db
      .prepare(
        "SELECT namespace, identity FROM records WHERE instr(body, ?)>0 ORDER BY namespace, identity LIMIT ?",
      )
      .all(text, Math.min(1000, Math.max(1, Math.floor(limit))))
      .map((row) => ({ namespace: String(row.namespace), id: String(row.identity) }));
  }

  project(
    namespace: string,
    identity: string,
    value: {
      search: string;
      status: string;
      sort: string;
      body: unknown;
    },
  ): void {
    this.db
      .prepare(
        `INSERT INTO projections VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(namespace, identity) DO UPDATE SET search=excluded.search,
      status=excluded.status, sort=excluded.sort, body=excluded.body`,
      )
      .run(
        namespace,
        identity,
        value.search.toLowerCase(),
        value.status,
        value.sort,
        stableJson(value.body),
      );
  }

  /** SQL filtering and bounded reads: page loads never materialize the full population. */
  page<T>(
    namespace: string,
    input: {
      q?: string;
      status?: string;
      statuses?: string[];
      state?: string;
      operationId?: string;
      page?: number;
      limit?: number;
    } = {},
  ) {
    const limit = Math.min(50, Math.max(1, Math.floor(input.limit || 20)));
    const q = (input.q ?? "").trim().toLowerCase().slice(0, 200);
    const status = input.status === "all" ? "" : (input.status ?? "");
    const state = input.state === "all" ? "" : (input.state ?? "");
    const filters = ["namespace=?"],
      args = [namespace];
    if (input.operationId) {
      filters.push("json_extract(body, '$.operationId')=?");
      args.push(input.operationId);
    }
    if (q) {
      filters.push("instr(search,?)>0");
      args.push(q);
    }
    if (input.statuses?.length) {
      filters.push(`status IN (${input.statuses.map(() => "?").join(",")})`);
      args.push(...input.statuses);
    }
    if (status) {
      filters.push("status=?");
      args.push(status);
    }
    if (state) {
      filters.push("json_extract(body, '$.state')=?");
      args.push(state);
    }
    const filter = filters.join(" AND ");
    const total = Number(
      this.db.prepare(`SELECT count(*) AS total FROM projections WHERE ${filter}`).get(...args)!
        .total,
    );
    const pages = Math.max(1, Math.ceil(total / limit));
    const page = Math.min(pages, Math.max(1, Math.floor(input.page || 1)));
    const rows = this.db
      .prepare(
        `SELECT body FROM projections WHERE ${filter} ORDER BY sort DESC, identity LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, (page - 1) * limit);
    return {
      items: rows.map((row) => JSON.parse(row.body as string) as T),
      total,
      page,
      pages,
      limit,
    };
  }

  replaceIssues(
    operation: string,
    issues: Array<{
      code: string;
      dependency: string;
      explanation: string;
      affectedCaptures: number;
      affectedCandidates: number;
      action: string;
    }>,
  ) {
    this.db.prepare("DELETE FROM operational_issues WHERE operation=?").run(operation);
    const insert = this.db.prepare(
      "INSERT INTO operational_issues VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const issue of issues)
      insert.run(
        operation,
        issue.code,
        issue.dependency,
        issue.explanation,
        issue.affectedCaptures,
        issue.affectedCandidates,
        issue.action,
        hashJson({ code: issue.code, dependency: issue.dependency }),
      );
  }

  groupedIssues(limit = 20) {
    const total = Number(
      this.db
        .prepare(
          "SELECT count(*) total FROM (SELECT 1 FROM operational_issues GROUP BY code,dependency)",
        )
        .get()!.total,
    );
    const rows = this.db
      .prepare(
        `SELECT code, dependency, group_id, min(explanation) explanation, sum(captures) captures, sum(candidates) candidates,
      count(*) operations, min(operation) operation, min(action) action FROM operational_issues
      GROUP BY code,dependency ORDER BY captures DESC,code,dependency LIMIT ?`,
      )
      .all(Math.min(50, Math.max(1, limit)));
    return {
      total,
      items: rows.map((row) => ({
        id: String(row.group_id),
        code: String(row.code),
        dependency: String(row.dependency),
        explanation: String(row.explanation),
        affectedCaptures: Number(row.captures),
        affectedCandidates: Number(row.candidates),
        operations: Number(row.operations),
        operationId: String(row.operation),
        action: String(row.action),
      })),
    };
  }

  issueOperations(id: string, pageNumber = 1) {
    if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error("Invalid issue identity");
    const total = Number(
      this.db.prepare("SELECT count(*) total FROM operational_issues WHERE group_id=?").get(id)!
        .total,
    );
    const limit = 20,
      pages = Math.max(1, Math.ceil(total / limit)),
      page = Math.min(pages, Math.max(1, Math.floor(pageNumber || 1)));
    const rows = this.db
      .prepare(
        "SELECT operation,explanation,captures,candidates FROM operational_issues WHERE group_id=? ORDER BY operation LIMIT ? OFFSET ?",
      )
      .all(id, limit, (page - 1) * limit);
    return {
      total,
      page,
      pages,
      limit,
      items: rows.map((row) => ({
        operationId: String(row.operation),
        explanation: String(row.explanation),
        captures: Number(row.captures),
        candidates: Number(row.candidates),
        run: this.read<import("../../contracts/src/catalog.js").RunSummary>(
          "catalog_runs",
          String(row.operation),
        ),
      })),
    };
  }

  /** The callback is synchronous: no network, file reads or awaits inside a transaction. */
  transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      if (result instanceof Promise) throw new Error("Journal transactions must be synchronous");
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  /** Maintenance traversal is bounded and keyed; normal page loads use projections. */
  recordPage(namespace: string, after = "", limit = 50): Array<{ id: string; value: unknown }> {
    return this.db
      .prepare(
        "SELECT identity,body FROM records WHERE namespace=? AND identity>? ORDER BY identity LIMIT ?",
      )
      .all(namespace, after, Math.min(50, Math.max(1, Math.floor(limit))))
      .map((row) => ({ id: String(row.identity), value: JSON.parse(String(row.body)) as unknown }));
  }

  clearProjection(namespace: string): void {
    this.db.prepare("DELETE FROM projections WHERE namespace=?").run(namespace);
  }

  list<T>(namespace: string): T[] {
    const rows = this.db
      .prepare("SELECT body FROM records WHERE namespace=? ORDER BY identity LIMIT 10001")
      .all(namespace);
    if (rows.length > 10000) throw new Error("Journal listing exceeds its bound");
    return rows.map((row) => JSON.parse(row.body as string) as T);
  }
}
