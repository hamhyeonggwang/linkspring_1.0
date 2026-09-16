import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LocalDatabase } from "../../desktop/database";
import { seedDemo } from "../../desktop/demo";
import { readState } from "../../lib/state-store";
import { executeAction } from "../../lib/state-actions";
import { candidatesFor } from "../../lib/domain";

const migrations = resolve("drizzle");
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "linkspring-test-"));
  return { dir, db: new LocalDatabase(join(dir, "work.sqlite"), migrations) };
}
test("local workflow persists across restart and rejects stale confirmation atomically", async () => {
  const f = fixture(); let db = f.db;
  try {
    await seedDemo(db);
    const state = await readState(db), slot = state.slots[0];
    const candidates = candidatesFor(slot, state, 0);
    assert.equal(candidates.length, 6);
    const participant = state.participants.find(p => p.type === slot.type)!;
    const body = { kind: "confirm", version: state.settings.state_revision, slotId: slot.id, participantId: participant.id };
    await executeAction(body, db, "test");
    await assert.rejects(executeAction(body, db, "test"));
    const confirmed = await readState(db);
    await executeAction({ kind: "notice", version: confirmed.settings.state_revision, slotId: slot.id }, db, "test");
    const saved = await readState(db);
    db.close(); db = new LocalDatabase(db.path, migrations);
    const reloaded = await readState(db);
    assert.deepEqual(reloaded, saved);
    assert.equal(reloaded.slots.find(s => s.id === slot.id)?.noticeStatus, "안내 완료");
    assert.equal(reloaded.audit.filter(a => a.action === "confirm").length, 1);
  } finally { db.close(); rmSync(f.dir, { recursive: true, force: true }); }
});
test("backup contains WAL commits; restore preserves a safety snapshot and fresh revision", async () => {
  const { dir, db } = fixture();
  try {
    await seedDemo(db);
    const before = await readState(db), backup = join(dir, "backup.sqlite");
    db.backup(backup);
    const person = before.participants[0];
    await executeAction({ kind: "participant", participant: { ...person, active: false }, version: before.settings.state_revision }, db, "test");
    const safety = db.restore(backup);
    const after = await readState(db);
    assert.equal(after.participants.find(p => p.id === person.id)?.active, true);
    assert.notEqual(after.settings.state_revision, before.settings.state_revision);
    const safetyDb = new LocalDatabase(safety, migrations);
    assert.equal((await readState(safetyDb)).participants.find(p => p.id === person.id)?.active, false);
    safetyDb.close();
    assert.equal(after.audit[0].action, "restore");
    assert.throws(() => db.backup(db.path));
    assert.throws(() => db.restore(db.path));
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
test("restore rejects altered schema without changing current data", async () => {
  const { dir, db } = fixture();
  try {
    await seedDemo(db);
    const before = await readState(db), backup = join(dir, "tampered.sqlite");
    db.backup(backup);
    const tampered = new DatabaseSync(backup);
    tampered.exec("CREATE TRIGGER unexpected AFTER INSERT ON participants BEGIN DELETE FROM slots; END;");
    tampered.close();
    assert.throws(() => db.restore(backup), /현재 버전/);
    assert.deepEqual(await readState(db), before);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
test("failed SQLite batches roll back all changes", async () => {
  const { dir, db } = fixture();
  try {
    await assert.rejects(db.batch([
      db.prepare("INSERT INTO system_settings(key,value) VALUES ('test','value')"),
      db.prepare("INSERT INTO mutation_guards(id,expected_revision) VALUES ('bad','invalid')"),
    ]));
    assert.equal(db.connection.prepare("SELECT * FROM system_settings WHERE key='test'").all().length, 0);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
test("upgrade creates a recoverable snapshot before applying new migrations", () => {
  const dir = mkdtempSync(join(tmpdir(), "linkspring-upgrade-")), oldMigrations = join(dir, "old");
  mkdirSync(oldMigrations);
  const files = readdirSync(migrations).filter(f => f.endsWith(".sql")).sort();
  for (const name of files.slice(0, -1)) copyFileSync(join(migrations, name), join(oldMigrations, name));
  let db = new LocalDatabase(join(dir, "work.sqlite"), oldMigrations);
  db.connection.prepare("INSERT INTO system_settings(key,value) VALUES ('custom','preserved')").run();
  db.close();
  try {
    db = new LocalDatabase(join(dir, "work.sqlite"), migrations);
    assert.equal(db.connection.prepare("SELECT value FROM system_settings WHERE key='custom'").get()?.value, "preserved");
    assert.equal(readdirSync(dir).filter(f => f.includes("before-upgrade")).length, 1);
    assert.equal(db.connection.prepare("SELECT * FROM desktop_migrations").all().length, files.length);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
