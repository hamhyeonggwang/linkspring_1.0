import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  existsSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DatabasePort, PreparedQuery } from "../lib/database-port";

class Query implements PreparedQuery {
  constructor(
    readonly owner: LocalDatabase,
    readonly sql: string,
    readonly values: SQLInputValue[] = [],
  ) {}
  bind(...values: unknown[]) {
    return new Query(this.owner, this.sql, values as SQLInputValue[]);
  }
  execute() {
    return {
      results: this.owner.connection.prepare(this.sql).all(...this.values),
    };
  }
  async run() {
    return this.execute();
  }
}

export class LocalDatabase implements DatabasePort {
  connection: DatabaseSync;
  constructor(
    readonly path: string,
    readonly migrationsDir: string,
    private snapshotBeforeUpgrade = true,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.connection = new DatabaseSync(path, { allowExtension: false });
    try {
      this.connection.exec(
        "PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;",
      );
      this.migrate();
    } catch (error) {
      this.connection.close();
      throw error;
    }
  }
  prepare(sql: string) {
    return new Query(this, sql);
  }
  async batch(queries: PreparedQuery[]) {
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      const result = queries.map((q) => {
        if (!(q instanceof Query) || q.owner !== this)
          throw new Error("다른 저장소의 요청입니다.");
        return q.execute();
      });
      this.connection.exec("COMMIT");
      return result;
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
    }
  }
  private migrate() {
    this.connection.exec(
      "CREATE TABLE IF NOT EXISTS desktop_migrations(name TEXT PRIMARY KEY,hash TEXT NOT NULL)",
    );
    const files = readdirSync(this.migrationsDir)
      .filter((f) => /^\d+.*\.sql$/.test(f))
      .sort();
    const applied = this.connection
      .prepare("SELECT name,hash FROM desktop_migrations ORDER BY name")
      .all();
    if (
      applied.length > files.length ||
      applied.some((row, i) => row.name !== files[i])
    )
      throw new Error("이 데이터는 다른 버전에서 생성되었습니다.");
    const migrations = files.map((name) => {
      const sql = readFileSync(join(this.migrationsDir, name), "utf8");
      return {
        name,
        sql,
        hash: createHash("sha256").update(sql).digest("hex"),
      };
    });
    if (applied.some((row, i) => row.hash !== migrations[i].hash))
      throw new Error("데이터 버전 검증에 실패했습니다.");
    if (
      this.snapshotBeforeUpgrade &&
      applied.length &&
      applied.length < migrations.length
    )
      this.backup(`${this.path}.before-upgrade-${Date.now()}.sqlite`);
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      for (const migration of migrations.slice(applied.length)) {
        this.connection.exec(migration.sql);
        this.connection
          .prepare("INSERT INTO desktop_migrations VALUES (?,?)")
          .run(migration.name, migration.hash);
      }
      this.connection.exec(`PRAGMA user_version=${migrations.length}; COMMIT;`);
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
    }
  }
  backup(destination: string) {
    if (resolve(destination) === resolve(this.path))
      throw new Error("현재 데이터 파일 위에 백업할 수 없습니다.");
    const temp = `${destination}.${randomUUID()}.tmp`;
    try {
      // SQLite makes a consistent snapshot, including committed WAL contents.
      this.connection.prepare("VACUUM INTO ?").run(temp);
      renameSync(temp, destination);
    } finally {
      rmSync(temp, { force: true });
    }
  }
  restore(source: string) {
    if (resolve(source) === resolve(this.path))
      throw new Error("현재 사용 중인 파일은 복원할 수 없습니다.");
    if (statSync(source).size > 50 * 1024 * 1024)
      throw new Error("백업 크기는 50MB 이하여야 합니다.");
    const staged = `${this.path}.restore-${randomUUID()}`;
    let candidate: DatabaseSync | undefined;
    try {
      candidate = new DatabaseSync(source, {
        readOnly: true,
        allowExtension: false,
      });
      const integrity = candidate.prepare("PRAGMA integrity_check").get();
      if (integrity?.integrity_check !== "ok")
        throw new Error("손상된 백업입니다.");
      const schema =
        "SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name";
      const history = "SELECT name,hash FROM desktop_migrations ORDER BY name";
      // Reconstruct a trusted schema for the backup's version before executing
      // any writes or migrations against its contents (including triggers).
      const applied = candidate.prepare(history).all();
      const current = this.connection.prepare(history).all();
      if (
        !applied.length ||
        applied.length > current.length ||
        JSON.stringify(applied) !==
          JSON.stringify(current.slice(0, applied.length))
      )
        throw new Error("지원하는 이전 버전 또는 현재 버전의 백업이 아닙니다.");
      const expected = new DatabaseSync(":memory:", { allowExtension: false });
      try {
        expected.exec(
          "CREATE TABLE IF NOT EXISTS desktop_migrations(name TEXT PRIMARY KEY,hash TEXT NOT NULL)",
        );
        for (const row of applied)
          expected.exec(
            readFileSync(join(this.migrationsDir, String(row.name)), "utf8"),
          );
        if (
          JSON.stringify(candidate.prepare(schema).all()) !==
          JSON.stringify(expected.prepare(schema).all())
        )
          throw new Error(
            "이전 또는 현재 버전의 정상적인 이어:봄 백업만 복원할 수 있습니다.",
          );
      } finally {
        expected.close();
      }
      candidate.prepare("VACUUM INTO ?").run(staged);
      candidate.close();
      candidate = undefined;
      const upgraded = new LocalDatabase(staged, this.migrationsDir, false);
      try {
        if (
          JSON.stringify(upgraded.connection.prepare(schema).all()) !==
          JSON.stringify(this.connection.prepare(schema).all())
        )
          throw new Error("백업 업그레이드 검증에 실패했습니다.");
      } finally {
        upgraded.close();
      }
      const safety = `${this.path}.before-restore-${Date.now()}.sqlite`;
      this.backup(safety);
      this.close();
      try {
        renameSync(staged, this.path);
      } finally {
        this.connection = new DatabaseSync(this.path, {
          allowExtension: false,
        });
        this.connection.exec(
          "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
        );
      }
      this.connection
        .prepare(
          "UPDATE system_settings SET value=? WHERE key='state_revision'",
        )
        .run(randomUUID());
      this.connection
        .prepare(
          "INSERT INTO audit_logs(slot_id,action,actor,detail) VALUES ('system','restore','로컬 담당자','백업 복원 · 이전 데이터 자동 보존')",
        )
        .run();
      return safety;
    } finally {
      candidate?.close();
      if (existsSync(staged)) rmSync(staged);
      for (const suffix of ["-wal", "-shm"])
        rmSync(staged + suffix, { force: true });
    }
  }
  close() {
    this.connection.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.connection.close();
  }
}
