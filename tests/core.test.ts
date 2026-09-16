import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  candidatesFor,
  dateSchema,
  emptyState,
  scheduleTokens,
  validSession,
  parseAvailability,
  type State,
  type Participant,
  type SlotInput,
} from "../lib/domain";
import {
  parseCsv,
  participantImport,
  scheduleImport,
  decodeCsv,
} from "../lib/csv";
import { analyzeAbsence, parseClaudePayload, ruleParse } from "../lib/absence";
import { readState, commit } from "../lib/state-store";
import { executeAction } from "../lib/state-actions";
import { checkOrigin, localAccess, coordinatorAccess } from "../lib/access";
import { sessionNotStarted } from "../lib/domain";

const day = "2030-01-07"; // Monday, synthetic fixture only.
const slot: SlotInput = {
  date: day,
  startTime: "09:00",
  endTime: "09:30",
  type: "작업치료",
  therapist: "OT-01",
};
const person = (
  id = "대기자-TEST0001",
  overrides: Partial<Participant> = {},
): Participant => ({
  id,
  type: "작업치료",
  availability: "월 09:00–12:00",
  since: "2025-01-01",
  recent: "없음",
  active: true,
  ...overrides,
});
const state = (overrides: Partial<State> = {}): State => ({
  ...structuredClone(emptyState),
  participants: [person()],
  ...overrides,
});

test("permissions deny missing identity, unlisted users and production dev bypass", () => {
  assert.throws(() => coordinatorAccess(undefined, "allowed@example.test"));
  assert.throws(() =>
    coordinatorAccess("other@example.test", "allowed@example.test"),
  );
  assert.throws(() => coordinatorAccess("allowed@example.test", undefined));
  assert.equal(
    coordinatorAccess("Allowed@example.test", " allowed@example.test "),
    "Allowed@example.test",
  );
  const local = new Request("http://127.0.0.1/api/state");
  assert.equal(localAccess(local, "1", false), true);
  assert.equal(localAccess(local, "1", true), false);
  assert.equal(
    localAccess(new Request("https://example.test/api/state"), "1", false),
    false,
  );
  assert.throws(() =>
    checkOrigin(
      new Request("https://example.test/api/state", {
        method: "POST",
        headers: { origin: "https://other.test" },
      }),
    ),
  );
  assert.throws(() =>
    checkOrigin(
      new Request("https://example.test/api/state", { method: "POST" }),
    ),
  );
  assert.doesNotThrow(() =>
    checkOrigin(
      new Request("https://example.test/api/state", {
        method: "POST",
        headers: { origin: "https://example.test" },
      }),
    ),
  );
});
test("expired sessions and Seoul midnight are evaluated against absolute time", () => {
  assert.equal(sessionNotStarted(slot, new Date("2030-01-06T23:59:59Z")), true);
  assert.equal(
    sessionNotStarted(slot, new Date("2030-01-07T00:00:00Z")),
    false,
  );
  assert.equal(
    sessionNotStarted(
      { date: day, startTime: "00:00" },
      new Date("2030-01-06T15:00:00Z"),
    ),
    false,
  );
});

test("30-minute sessions reject lunch, midnight, malformed and reversed times", () => {
  for (const [a, b] of [
    ["08:30", "09:00"],
    ["11:30", "12:00"],
    ["13:00", "13:30"],
    ["17:30", "18:00"],
  ])
    assert.equal(validSession(a, b), true);
  for (const [a, b] of [
    ["12:00", "12:30"],
    ["12:30", "13:00"],
    ["09:10", "09:40"],
    ["23:30", "00:00"],
    ["09:00", "08:30"],
    ["09:00", "09:99"],
  ])
    assert.equal(validSession(a, b), false);
  assert.equal(dateSchema.safeParse("2030-02-29").success, false);
  assert.equal(dateSchema.safeParse("2028-02-29").success, true);
});
test("candidate eligibility uses weekday, service, activation, waiting date and full interval", () => {
  assert.equal(candidatesFor(slot, state()).length, 1);
  for (const change of [
    { active: false },
    { type: "교육" },
    { since: "2030-01-08" },
    { availability: "화 09:00–12:00" },
    { availability: "월 09:00–09:20" },
  ])
    assert.equal(
      candidatesFor(slot, state({ participants: [person(undefined, change)] }))
        .length,
      0,
    );
  assert.ok(parseAvailability("월·수 09:00–12:00"));
});
test("100 people sort reproducibly by waiting, recent connection, then alias", () => {
  const people = Array.from({ length: 100 }, (_, i) =>
    person(`대기자-${String(i).padStart(4, "0")}`),
  );
  const result = candidatesFor(slot, state({ participants: people.reverse() }));
  assert.equal(result.length, 100);
  assert.equal(result[0].participant.id, "대기자-0000");
  const result2 = candidatesFor(
    slot,
    state({
      participants: [
        person("대기자-AAAA", { recent: "2025-12-01" }),
        person("대기자-BBBB", { recent: "2025-01-01" }),
        person("대기자-CCCC", { since: "2024-01-01" }),
      ],
    }),
  );
  assert.deepEqual(
    result2.map((c) => c.participant.id),
    ["대기자-CCCC", "대기자-BBBB", "대기자-AAAA"],
  );
});
test("date-specific requests override weekly availability and cancelled requests never match", () => {
  const imported = participantImport(
    `가명 ID,치료,대기 시작일,희망 날짜,오전,오후,상태\n대기자-TEST0001,작업치료,2025-01-01,${day},09:00,,처리 대기`,
  );
  const s = state({
    participants: imported.participants,
    participantRequests: imported.requests,
  });
  assert.equal(candidatesFor(slot, s).length, 1);
  assert.equal(candidatesFor({ ...slot, date: "2030-01-14" }, s).length, 0);
  s.participantRequests[0].status = "신청 취소";
  assert.equal(candidatesFor(slot, s).length, 0);
});
test("nearby filters identify alternatives without making them confirmable", () => {
  const s = state({
    participants: [person(undefined, { availability: "월 09:30–10:00" })],
  });
  assert.equal(candidatesFor(slot, s, 0).length, 0);
  assert.equal(candidatesFor(slot, s, 30)[0].exact, false);
  s.participants[0].availability = "월 10:00–10:30";
  assert.equal(candidatesFor(slot, s, 30).length, 0);
  assert.deepEqual(candidatesFor(slot, s, 60)[0].alternativeStarts, ["10:00"]);
});
test("overlapping completed connections excluded, adjacent sessions allowed", () => {
  const s = state({
    slots: [
      {
        ...slot,
        id: "existing",
        status: "연결 완료",
        assignedParticipant: "대기자-TEST0001",
        noticeStatus: "미안내",
        noticeText: "",
        assignedAt: null,
        noticeCompletedAt: null,
        revision: 0,
      },
    ],
  });
  assert.equal(candidatesFor(slot, s).length, 0);
  assert.equal(
    candidatesFor({ ...slot, startTime: "09:30", endTime: "10:00" }, s).length,
    1,
  );
});
test("CSV parser supports quoted commas/CRLF; rejects missing headers, invalid dates and duplicate rows", () => {
  assert.deepEqual(parseCsv('\uFEFFA,B\r\n"one,two","quote""here"\r\n'), [
    ["A", "B"],
    ["one,two", 'quote"here'],
  ]);
  assert.throws(() => parseCsv('A,B\n"unfinished,B'));
  assert.throws(() => participantImport("이름,전화\n테스트,000"));
  const head = "일자,부서,담당자 코드,시작,종료,예약 코드";
  const row = `${day},작업치료,OT-01,09:00,09:30,BOOK01`;
  assert.equal(scheduleImport(`${head}\n${row}`).entries.length, 1);
  assert.throws(() => scheduleImport(`${head}\n${row}\n${row}`));
  assert.throws(() =>
    scheduleImport(
      `${head}\n${row}\n2030-01-08,작업치료,OT-01,09:30,10:00,BOOK02`,
    ),
  );
  assert.throws(() =>
    scheduleImport(`${head}\n2030-02-30,작업치료,OT-01,09:00,09:30,BOOK01`),
  );
});
test("CSV decoding supports UTF-8 and EUC-KR", async () => {
  assert.equal(await decodeCsv(new File(["가명"], "utf8.csv")), "가명");
  assert.equal(
    await decodeCsv(new File([new Uint8Array([0xb0, 0xa1])], "euckr.csv")),
    "가",
  );
});
test("schedule token allowlist removes synthetic names, contacts, birthdate and diagnosis", () => {
  const text = scheduleTokens(
    "가상아동 이름테스트 010-0000-0000 생년월일: 2020-02-02 진단내용 내일 오전 9시 작업치료 OT-01 결석합니다",
  );
  assert.equal(text, "내일 오전 9시 작업치료 OT-01");
  assert.equal(scheduleTokens(text), text);
  assert.equal(scheduleTokens("2020-02-02 2월 2일 09:00"), "09:00");
});
test("rule fallback leaves missing fields blank and handles year boundary", () => {
  assert.equal(
    ruleParse("내일 오후 2시 작업치료 OT-01", "2029-12-31").date,
    "2030-01-01",
  );
  assert.deepEqual(ruleParse("작업치료", "2030-01-01"), {
    date: "",
    startTime: "",
    endTime: "",
    type: "작업치료",
    therapist: "",
  });
  assert.equal(ruleParse("오늘 내일 09:00 10:00", "2030-01-01").date, "");
});
test("Claude output must be complete, valid, untruncated and a single tool object", () => {
  const payload = {
    stop_reason: "tool_use",
    content: [{ type: "tool_use", name: "structure_absence", input: slot }],
  };
  assert.deepEqual(parseClaudePayload(payload), slot);
  assert.equal(
    parseClaudePayload({ ...payload, stop_reason: "max_tokens" }),
    null,
  );
  assert.equal(
    parseClaudePayload({
      ...payload,
      content: [{ ...payload.content[0], input: { ...slot, therapist: null } }],
    }),
    null,
  );
  assert.equal(
    parseClaudePayload({
      ...payload,
      content: [
        {
          ...payload.content[0],
          input: { ...slot, startTime: "12:00", endTime: "12:30" },
        },
      ],
    }),
    null,
  );
});
test("provider failure and missing config return labelled fallback without leaking error text", async () => {
  const text = "내일 09:00 작업치료 OT-01";
  const fail = await analyzeAbsence(
    text,
    day,
    { apiKey: "fake-test-key", model: "test-model" },
    async () => {
      throw new Error("PRIVATE_BODY");
    },
  );
  assert.equal(fail.source, "rules");
  assert.doesNotMatch(JSON.stringify(fail), /PRIVATE_BODY|fake-test-key/);
  const missing = await analyzeAbsence("교육", day, {});
  assert.equal(missing.fields.therapist, "");
  const success = await analyzeAbsence(
    `${day} 09:00 작업치료 OT-01`,
    day,
    { apiKey: "fake-test-key", model: "test-model" },
    async (_url, init) => {
      assert.ok(init?.signal);
      return Response.json({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", name: "structure_absence", input: slot }],
      });
    },
  );
  assert.equal(success.source, "claude");
});

// SQLite implements D1's prepared/batch contract; batch uses one transaction.
// The same migrations and server action code run here; no production DB touched.
function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(new URL("../drizzle", import.meta.url))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    sqlite.exec(
      readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
    );
  class Statement {
    args: (string | number | null)[] = [];
    constructor(public sql: string) {}
    bind(...args: (string | number | null)[]) {
      this.args = args;
      return this;
    }
    async run() {
      return {
        success: true,
        results: sqlite.prepare(this.sql).all(...this.args),
      };
    }
  }
  const db = {
    prepare: (sql: string) => new Statement(sql),
    batch: async (statements: Statement[]) => {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const s of statements) results.push(await s.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  } as unknown as D1Database;
  return { db, sqlite };
}
async function action(db: D1Database, body: Record<string, unknown>) {
  const s = await readState(db);
  return executeAction(
    { ...body, version: s.settings.state_revision },
    db,
    "test-coordinator",
  );
}
async function seed(db: D1Database) {
  await action(db, { kind: "participant", participant: person() });
  await action(
    db,
    scheduleImport(
      `일자,부서,담당자 코드,시작,종료,예약 코드\n${day},작업치료,OT-01,09:00,09:30,BOOK01\n${day},작업치료,OT-02,09:00,09:30,BOOK02`,
    ),
  );
  await action(db, { kind: "create", slot });
  await action(db, { kind: "create", slot: { ...slot, therapist: "OT-02" } });
}
test("real action flow persists corrected inputs, confirmation, audit and manual notice", async () => {
  const { db, sqlite } = fixture();
  try {
    await seed(db);
    const before = await readState(db);
    assert.equal(before.slots.length, 2);
    const id = before.slots[0].id;
    await action(db, {
      kind: "confirm",
      slotId: id,
      participantId: person().id,
    });
    const saved = await readState(db);
    const s = saved.slots.find((s) => s.id === id)!;
    assert.equal(s.status, "연결 완료");
    assert.equal(s.noticeStatus, "미안내");
    assert.ok(saved.audit.some((a) => a.action === "confirm"));
    assert.equal(
      candidatesFor(
        saved.slots.find((s) => s.id !== id)!,
        saved,
      ).length,
      0,
    );
    await assert.rejects(
      action(db, {
        kind: "confirm",
        slotId: saved.slots.find((s) => s.id !== id)!.id,
        participantId: person().id,
      }),
    );
    await action(db, { kind: "notice", slotId: id });
    assert.equal(
      (await readState(db)).slots.find((s) => s.id === id)!.noticeStatus,
      "안내 완료",
    );
    await assert.rejects(action(db, { kind: "notice", slotId: id }));
    await assert.rejects(action(db, { kind: "hold", slotId: id }));
  } finally {
    sqlite.close();
  }
});
test("stale concurrent confirmation is rejected without partial audit/state changes", async () => {
  const { db, sqlite } = fixture();
  try {
    await seed(db);
    const s = await readState(db),
      version = s.settings.state_revision;
    await executeAction(
      {
        kind: "confirm",
        version,
        slotId: s.slots[0].id,
        participantId: person().id,
      },
      db,
      "A",
    );
    await assert.rejects(
      executeAction(
        {
          kind: "confirm",
          version,
          slotId: s.slots[0].id,
          participantId: person().id,
        },
        db,
        "B",
      ),
    );
    const after = await readState(db);
    assert.equal(after.audit.filter((a) => a.action === "confirm").length, 1);
    await assert.rejects(
      commit(
        db,
        version,
        [db.prepare("UPDATE participants SET active=0")],
        "B",
        "test",
        "test",
      ),
    );
    assert.equal((await readState(db)).participants[0].active, true);
  } finally {
    sqlite.close();
  }
});
test("failed storage batch rolls back revision, writes and audit", async () => {
  const { db, sqlite } = fixture();
  try {
    const before = await readState(db);
    await assert.rejects(
      commit(
        db,
        before.settings.state_revision,
        [
          db.prepare(
            "INSERT INTO system_settings(key,value) VALUES ('sentinel','should-rollback')",
          ),
          db.prepare("INSERT INTO nonexistent_table VALUES (1)"),
        ],
        "A",
        "test",
        "test",
      ),
    );
    const after = await readState(db);
    assert.equal(after.settings.state_revision, before.settings.state_revision);
    assert.equal(after.settings.sentinel, undefined);
    assert.equal(after.audit.length, 0);
  } finally {
    sqlite.close();
  }
});
test("CSV imports 100 synthetic people atomically and ignores unknown fields", async () => {
  const { db, sqlite } = fixture();
  try {
    const head = "가명 ID,치료,대기 시작일,희망 날짜,오전,오후,상태";
    const rows = Array.from(
      { length: 100 },
      (_, i) =>
        `대기자-${String(i).padStart(4, "0")},작업치료,2025-01-01,${day},09:00,,처리 대기`,
    );
    const input = participantImport([head, ...rows].join("\n"));
    await action(db, { ...input, unknown: "discard" });
    const saved = await readState(db);
    assert.equal(saved.participants.length, 100);
    assert.equal(saved.participantRequests.length, 100);
    assert.equal(saved.audit.length, 1);
    await assert.rejects(
      action(db, {
        ...input,
        requests: [...input.requests, input.requests[0]],
      }),
    );
    assert.equal((await readState(db)).audit.length, 1);
  } finally {
    sqlite.close();
  }
});
test("server rejects unlisted slots, nearby-only matches and changes to registered schedule", async () => {
  const { db, sqlite } = fixture();
  try {
    await assert.rejects(action(db, { kind: "create", slot }));
    await seed(db);
    await action(db, {
      kind: "participant",
      participant: person(undefined, { availability: "월 09:30–10:00" }),
    });
    const s = await readState(db);
    await assert.rejects(
      action(db, {
        kind: "confirm",
        slotId: s.slots[0].id,
        participantId: person().id,
      }),
    );
    await assert.rejects(
      action(
        db,
        scheduleImport(
          `일자,부서,담당자 코드,시작,종료,예약 코드\n${day},작업치료,OT-01,10:00,10:30,BOOK01`,
        ),
      ),
    );
    assert.equal((await readState(db)).scheduleEntries.length, 2);
  } finally {
    sqlite.close();
  }
});
