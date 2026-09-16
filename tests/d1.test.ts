import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { readState, commit } from "../lib/state-store";
import { executeAction } from "../lib/state-actions";
import { participantImport, scheduleImport } from "../lib/csv";

test("Cloudflare local D1 persists confirmed links across restart and rolls back stale batches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "linkspring-d1-test-"));
  const create = () =>
    new Miniflare({
      modules: true,
      script: 'export default {fetch(){return new Response("test")}}',
      compatibilityDate: "2026-05-22",
      d1Databases: { DB: "linkspring-isolated-test" },
      d1Persist: directory,
    });
  let mf = create();
  try {
    let db = (await mf.getD1Database("DB")) as unknown as D1Database;
    for (const file of (await readdir(new URL("../drizzle", import.meta.url)))
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      const sql = await readFile(
        new URL(`../drizzle/${file}`, import.meta.url),
        "utf8",
      );
      for (const statement of sql
        .split("--> statement-breakpoint")
        .filter((s) => s.trim()))
        await db.prepare(statement).run();
    }
    const act = async (body: Record<string, unknown>) =>
      executeAction(
        { ...body, version: (await readState(db)).settings.state_revision },
        db,
        "synthetic-test",
      );
    const day = "2030-01-07";
    await act(
      participantImport(
        `가명 ID,치료,대기 시작일,희망 날짜,오전,오후,상태\n대기자-D1TEST01,작업치료,2025-01-01,${day},09:00,,처리 대기`,
      ),
    );
    await act(
      scheduleImport(
        `일자,부서,담당자 코드,시작,종료,예약 코드\n${day},작업치료,OT-01,09:00,09:30,SAMPLE01`,
      ),
    );
    await act({
      kind: "create",
      slot: {
        date: day,
        startTime: "09:00",
        endTime: "09:30",
        type: "작업치료",
        therapist: "OT-01",
      },
    });
    const before = await readState(db);
    await act({
      kind: "confirm",
      slotId: before.slots[0].id,
      participantId: "대기자-D1TEST01",
    });
    await assert.rejects(
      commit(
        db,
        before.settings.state_revision,
        [db.prepare("UPDATE participants SET active=0")],
        "second-test",
        "must-rollback",
        "test",
      ),
    );
    const confirmed = await readState(db);
    assert.equal(confirmed.slots[0].status, "연결 완료");
    assert.equal(confirmed.participants[0].active, true);
    assert.equal(confirmed.audit.length, 4);
    await mf.dispose();
    mf = create();
    db = (await mf.getD1Database("DB")) as unknown as D1Database;
    const restarted = await readState(db);
    assert.equal(restarted.slots[0].assignedParticipant, "대기자-D1TEST01");
    assert.equal(restarted.audit.length, 4);
    assert.equal(
      restarted.settings.state_revision,
      confirmed.settings.state_revision,
    );
  } finally {
    await mf.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
