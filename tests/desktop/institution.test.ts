import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  readdirSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LocalDatabase } from "../../desktop/database";
import { readState } from "../../lib/state-store";
import { executeAction } from "../../lib/state-actions";
import {
  importParticipantsCsv,
  importScheduleCsv,
  institutionTimes,
} from "../../lib/institution-csv";
import { candidatesFor } from "../../lib/domain";

const header =
  "타임스탬프,아동이름,아동 생년월일,보강치료 희망 날짜,치료,오전,오후,비고";
const personCsv = `${header}\n2025. 1. 2. 오후 1:30:00,아동001,2018-04-05,2030-01-07,작업,09:00~11:00,,`;
const scheduleCsv =
  "Unnamed: 0,일자,요일,부서,아이디,치료사,건수,08:30,09:00,09:30\n0,2030. 1. 7.,월,작업,001,치료사01,2,,r001,r002\n1,2030-01-08,화,작업,001,치료사01,1,,r003,";
const migrations = resolve("drizzle");

test("institution CSV has no required alias column and omits birthdate and raw notes", () => {
  const p = importParticipantsCsv(personCsv);
  assert.equal(p.participants[0].externalCode, "아동001");
  assert.match(p.participants[0].id, /^대기자-[A-F0-9]{32}$/);
  assert.equal(p.requests[0].submittedTime, "2025-01-02T13:30:00+09:00");
  assert.equal(p.requests[0].morningTimes, "09:00–11:00");
  assert(!JSON.stringify(p).includes("2018-04-05"));
  const sensitive = personCsv + "상담 후 재확인";
  assert.throws(() => importParticipantsCsv(sensitive), /2행 · 비고/);
  const mapped = importParticipantsCsv(sensitive, undefined, {
    statuses: { "상담 후 재확인": "추가 확인 필요" },
  });
  assert.equal(mapped.requests[0].status, "추가 확인 필요");
  assert(!JSON.stringify(mapped).includes("상담 후 재확인"));
  assert.throws(
    () => importParticipantsCsv(personCsv.replace("아동001", "***")),
    /구별할 수 없는/,
  );
  assert.throws(
    () => importParticipantsCsv(personCsv.replace("2030-01-07", "2030-02-30")),
    /2행.*실제 날짜/,
  );
});
test("time and therapy expressions require explicit meaning when ambiguous", () => {
  assert.equal(institutionTimes("1:00, 오후 2시", "오후", 2), "13:00, 14:00");
  assert.equal(institutionTimes("전체", "오전", 2), "08:30–12:00");
  assert.throws(() => institutionTimes("09:00~08:30", "오전", 2));
  assert.throws(
    () => importParticipantsCsv(personCsv.replace(",작업,", ",센터A,")),
    /기관 표현 연결/,
  );
  assert.equal(
    importParticipantsCsv(personCsv.replace(",작업,", ",센터A,"), undefined, {
      therapies: { 센터A: "작업치료" },
    }).participants[0].type,
    "작업치료",
  );
});
test("schedule preserves source labels, multiple dates and repeated ten-minute cells", () => {
  const parsed = importScheduleCsv(scheduleCsv);
  assert.deepEqual(parsed.dates, ["2030-01-07", "2030-01-08"]);
  assert.equal(parsed.entries.length, 3);
  assert.equal(parsed.staff.length, 1);
  assert.equal(parsed.staff[0].externalCode, "001");
  assert.equal(parsed.entries[0].therapistName, "치료사01");
  assert.equal(parsed.entries[0].treatmentCode, "r001");
  const repeats =
    "Unnamed,일자,요일,부서,아이디,치료사,건수,,,\n0,2030-01-07,월,작업,001,치료사01,1,r001,r001,r001";
  assert.throws(() => importScheduleCsv(repeats), /첫 시간과 열 간격/);
  assert.throws(
    () =>
      importScheduleCsv(repeats, undefined, { firstTime: "09:00", step: 10 }),
    /30분 시작/,
  );
  assert.equal(
    importScheduleCsv(repeats, undefined, {
      firstTime: "09:00",
      step: 10,
      cells: "filled",
    }).entries.length,
    1,
  );
  assert.throws(
    () =>
      importScheduleCsv(repeats.replace(/r001$/, "r002"), undefined, {
        firstTime: "09:00",
        step: 10,
        cells: "filled",
      }),
    /반복 예약 칸/,
  );
});
test("local imports preserve identities, inactive and completed statuses, linkage, backup and restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "linkspring-institution-"));
  let db = new LocalDatabase(join(dir, "work.sqlite"), migrations);
  const act = async (data: object) =>
    executeAction(
      { ...data, version: (await readState(db)).settings.state_revision },
      db,
      "test",
    );
  try {
    await act(importParticipantsCsv(personCsv));
    await act(importScheduleCsv(scheduleCsv));
    let state = await readState(db);
    const id = state.participants[0].id,
      staffId = state.staff![0].id;
    const first = state.scheduleEntries[0];
    await act({
      kind: "create",
      slot: {
        date: first.date,
        startTime: first.startTime,
        endTime: first.endTime,
        type: first.department,
        therapist: staffId,
      },
    });
    state = await readState(db);
    assert.equal(candidatesFor(state.slots[0], state)[0].participant.id, id);
    await act({
      kind: "confirm",
      slotId: state.slots[0].id,
      participantId: id,
    });
    state = await readState(db);
    await act({ kind: "notice", slotId: state.slots[0].id });
    await act({
      kind: "participant",
      participant: { ...state.participants[0], active: false },
    });
    db.connection
      .prepare("UPDATE participant_requests SET status='처리 완료'")
      .run();
    await act(importParticipantsCsv(personCsv, await readState(db)));
    await act(importScheduleCsv(scheduleCsv, await readState(db)));
    state = await readState(db);
    assert.equal(state.participants.length, 1);
    assert.equal(state.participants[0].id, id);
    assert.equal(state.participants[0].active, false);
    assert.equal(state.participants[0].recent, "2030-01-07");
    assert.equal(state.participantRequests[0].status, "처리 완료");
    assert.equal(state.slots[0].noticeStatus, "안내 완료");
    assert.equal(state.staff![0].id, staffId);
    assert.equal(state.scheduleEntries.length, 3);
    assert(!JSON.stringify(state).includes("2018-04-05"));
    const invalid = importScheduleCsv(
      scheduleCsv.replace("r001,r002", ",r002"),
      state,
    );
    await assert.rejects(act(invalid), /이미 등록된 회기/);
    assert.deepEqual(await readState(db), state);
    const backup = join(dir, "backup.sqlite");
    db.backup(backup);
    db.close();
    db = new LocalDatabase(join(dir, "work.sqlite"), migrations);
    assert.deepEqual(await readState(db), state);
    db.restore(backup);
    assert.equal((await readState(db)).participants[0].id, id);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("latest application wins and ambiguous duplicates are rejected", () => {
  const recent = personCsv
    .replace("2025. 1. 2. 오후 1:30:00", "2025. 2. 3. 오전 9:00:00")
    .replace("09:00~11:00", "10:00~11:00");
  const p = importParticipantsCsv(personCsv + "\n" + recent.split("\n")[1]);
  assert.equal(p.requests.length, 1);
  assert.equal(p.requests[0].morningTimes, "10:00–11:00");
  assert.throws(
    () =>
      importParticipantsCsv(
        personCsv +
          "\n" +
          personCsv.split("\n")[1].replace("09:00~11:00", "10:00~11:00"),
      ),
    /중복 신청/,
  );
});
test("version 1.0 backup is validated and upgraded without modifying original backup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "linkspring-old-backup-")),
    old = join(dir, "old-migrations");
  mkdirSync(old);
  for (const name of readdirSync(migrations).filter(
    (n) => n.endsWith(".sql") && n < "0007",
  ))
    copyFileSync(join(migrations, name), join(old, name));
  const backup = join(dir, "old.sqlite");
  const prior = new LocalDatabase(backup, old);
  prior.connection
    .prepare(
      "INSERT INTO system_settings(key,value) VALUES ('institution','retained')",
    )
    .run();
  prior.close();
  const db = new LocalDatabase(join(dir, "work.sqlite"), migrations);
  try {
    db.restore(backup);
    assert.equal((await readState(db)).settings.institution, "retained");
    assert.deepEqual((await readState(db)).staff, []);
    const original = new LocalDatabase(backup, old);
    original.close();
    assert.equal(
      readdirSync(dir).filter((n) => n.includes("before-restore")).length,
      1,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
