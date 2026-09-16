import { z } from "zod";
import { AppError } from "./errors";
import { readState, commit } from "./state-store";
import {
  slotInputSchema,
  participantSchema,
  requestSchema,
  scheduleSchema,
  candidatesFor,
  requestIntervals,
  parseAvailability,
  noticeTemplates,
  dateSchema,
  today,
  sessionNotStarted,
  type State,
} from "./domain";

const versionSchema = z.string().uuid();
const actionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("create"),
    version: versionSchema,
    slot: slotInputSchema,
  }),
  z.object({
    kind: z.literal("confirm"),
    version: versionSchema,
    slotId: z.string().max(100),
    participantId: z.string().max(80),
  }),
  z.object({
    kind: z.literal("hold"),
    version: versionSchema,
    slotId: z.string().max(100),
  }),
  z.object({
    kind: z.literal("notice"),
    version: versionSchema,
    slotId: z.string().max(100),
  }),
  z.object({
    kind: z.literal("participant"),
    version: versionSchema,
    participant: participantSchema,
  }),
  z.object({
    kind: z.literal("participants_import"),
    version: versionSchema,
    participants: z.array(participantSchema).min(1).max(1000),
    requests: z.array(requestSchema).min(1).max(3000),
  }),
  z.object({
    kind: z.literal("schedule_import"),
    version: versionSchema,
    date: dateSchema,
    entries: z.array(scheduleSchema).min(1).max(500),
  }),
  z.object({
    kind: z.literal("setting"),
    version: versionSchema,
    value: z.enum(noticeTemplates),
  }),
]);
function unique(values: string[]) {
  if (new Set(values).size !== values.length)
    throw new AppError(400, "중복된 행을 제거한 뒤 다시 반영해 주세요.");
}
function requireVersion(state: State, version: string) {
  if (state.settings.state_revision !== version)
    throw new AppError(
      409,
      "다른 변경이 반영되었습니다. 새로고침 후 다시 확인해 주세요.",
    );
}
export async function executeAction(
  body: unknown,
  db: D1Database,
  actor: string,
) {
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success)
    throw new AppError(
      400,
      "입력한 날짜·시간·코드와 필수 항목을 확인해 주세요.",
    );
  const input = parsed.data,
    state = await readState(db);
  requireVersion(state, input.version);
  const operations: D1PreparedStatement[] = [];
  let target = "settings",
    detail = "";
  if (input.kind === "create") {
    const s = input.slot;
    target = crypto.randomUUID();
    if (!sessionNotStarted(s))
      throw new AppError(400, "이미 시작한 회기는 새로 등록할 수 없습니다.");
    if (
      !state.scheduleEntries.some(
        (e) =>
          e.date === s.date &&
          e.therapistId === s.therapist &&
          e.department === s.type &&
          e.startTime === s.startTime &&
          e.endTime === s.endTime,
      )
    )
      throw new AppError(
        400,
        "해당 날짜의 시간표에서 담당자·서비스·시간이 일치하는 회기를 먼저 확인해 주세요.",
      );
    if (
      state.slots.some(
        (e) =>
          e.date === s.date &&
          e.therapist === s.therapist &&
          e.startTime === s.startTime,
      )
    )
      throw new AppError(409, "이미 등록된 회기입니다.");
    operations.push(
      db
        .prepare(
          "INSERT INTO slots(id,date,time,therapy_type,therapist,status) VALUES (?,?,?,?,?,'처리 대기')",
        )
        .bind(
          target,
          s.date,
          `${s.startTime}–${s.endTime}`,
          s.type,
          s.therapist,
        ),
    );
  } else if (
    input.kind === "confirm" ||
    input.kind === "hold" ||
    input.kind === "notice"
  ) {
    target = input.slotId;
    const s = state.slots.find((s) => s.id === target);
    if (!s) throw new AppError(404, "회기를 찾을 수 없습니다.");
    if (input.kind === "confirm") {
      if (
        s.status === "연결 완료" ||
        !slotInputSchema.safeParse(s).success ||
        !sessionNotStarted(s)
      )
        throw new AppError(409, "현재 연결할 수 없는 회기입니다.");
      if (
        !state.scheduleEntries.some(
          (e) =>
            e.date === s.date &&
            e.therapistId === s.therapist &&
            e.department === s.type &&
            e.startTime === s.startTime &&
            e.endTime === s.endTime,
        )
      )
        throw new AppError(
          409,
          "시간표가 변경되었습니다. 담당자와 회기를 다시 확인해 주세요.",
        );
      if (
        !candidatesFor(s, state, 0).some(
          (c) => c.participant.id === input.participantId && c.exact,
        )
      )
        throw new AppError(
          409,
          "대기자의 가능 일정이 맞지 않거나 이미 연결되었습니다.",
        );
      const template =
        noticeTemplates.find((t) => t === state.settings.notice_template) ??
        noticeTemplates[0];
      const notice = template
        .replaceAll("{날짜}", s.date)
        .replaceAll("{시간}", `${s.startTime}–${s.endTime}`)
        .replaceAll("{치료종류}", s.type);
      operations.push(
        db
          .prepare(
            "UPDATE slots SET status='연결 완료',assigned_participant=?,assigned_at=?,notice_text=?,notice_status='미안내',revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=?",
          )
          .bind(input.participantId, new Date().toISOString(), notice, target),
      );
      operations.push(
        db
          .prepare(
            "UPDATE participants SET recent_connection=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
          )
          .bind(s.date, input.participantId),
      );
      detail = `${input.participantId} · 일치 조건 검증 후 담당자 확정`;
    } else if (input.kind === "hold") {
      if (s.status === "연결 완료")
        throw new AppError(409, "완료된 회기는 보류할 수 없습니다.");
      operations.push(
        db
          .prepare(
            "UPDATE slots SET status='추가 확인 필요',revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=?",
          )
          .bind(target),
      );
    } else {
      if (s.status !== "연결 완료" || s.noticeStatus === "안내 완료")
        throw new AppError(409, "안내 상태를 다시 확인해 주세요.");
      operations.push(
        db
          .prepare(
            "UPDATE slots SET notice_status='안내 완료',notice_completed_at=?,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=?",
          )
          .bind(new Date().toISOString(), target),
      );
    }
  } else if (
    input.kind === "participant" ||
    input.kind === "participants_import"
  ) {
    const people =
      input.kind === "participant" ? [input.participant] : input.participants;
    unique(people.map((p) => p.id));
    target =
      input.kind === "participant"
        ? input.participant.id
        : "participant-import";
    for (const p of people) {
      if (p.since > today())
        throw new AppError(400, "대기 시작일은 오늘 이후일 수 없습니다.");
    }
    const normalized = people.map((p) => ({
      ...p,
      availability: JSON.stringify(parseAvailability(p.availability)),
      active: Number(p.active),
    }));
    operations.push(
      db
        .prepare(
          "INSERT INTO participants(id,therapy_type,availability,waiting_since,recent_connection,active) SELECT json_extract(value,'$.id'),json_extract(value,'$.type'),json_extract(value,'$.availability'),json_extract(value,'$.since'),json_extract(value,'$.recent'),json_extract(value,'$.active') FROM json_each(?) WHERE 1 ON CONFLICT(id) DO UPDATE SET therapy_type=excluded.therapy_type,availability=excluded.availability,waiting_since=excluded.waiting_since,active=excluded.active,updated_at=CURRENT_TIMESTAMP",
        )
        .bind(JSON.stringify(normalized)),
    );
    if (input.kind === "participants_import") {
      unique(input.requests.map((r) => r.id));
      const ids = new Set(people.map((p) => p.id));
      for (const r of input.requests) {
        if (
          !ids.has(r.participantId) ||
          r.id !== `${r.participantId}|${r.desiredDate}|${r.therapyTypes}`
        )
          throw new AppError(
            400,
            "희망 일정의 대기자 코드 또는 신청 ID를 확인하세요.",
          );
        try {
          if (
            ![
              ...requestIntervals(r.morningTimes),
              ...requestIntervals(r.afternoonTimes),
            ].length
          )
            throw new Error();
        } catch {
          throw new AppError(400, "희망 시간 형식을 확인해 주세요.");
        }
      }
      operations.push(
        db
          .prepare(
            "INSERT INTO participant_requests(id,participant_id,submitted_at,desired_date,therapy_types,morning_times,afternoon_times,status,note) SELECT json_extract(value,'$.id'),json_extract(value,'$.participantId'),json_extract(value,'$.submittedAt'),json_extract(value,'$.desiredDate'),json_extract(value,'$.therapyTypes'),json_extract(value,'$.morningTimes'),json_extract(value,'$.afternoonTimes'),json_extract(value,'$.status'),'' FROM json_each(?) WHERE 1 ON CONFLICT(id) DO UPDATE SET submitted_at=excluded.submitted_at,desired_date=excluded.desired_date,therapy_types=excluded.therapy_types,morning_times=excluded.morning_times,afternoon_times=excluded.afternoon_times,status=excluded.status,note='',updated_at=CURRENT_TIMESTAMP",
          )
          .bind(JSON.stringify(input.requests)),
      );
    }
    detail = `대기자 ${people.length}명 반영`;
  } else if (input.kind === "schedule_import") {
    target = input.date;
    unique(input.entries.map((e) => `${e.therapistId}|${e.startTime}`));
    if (
      input.entries.some(
        (e) =>
          e.date !== input.date ||
          e.id !== `${e.date}|${e.therapistId}|${e.startTime}` ||
          e.therapistName !== e.therapistId,
      )
    )
      throw new AppError(
        400,
        "동일 날짜의 익명 담당자 코드 시간표만 반영할 수 있습니다.",
      );
    if (
      state.slots.some(
        (s) =>
          s.date === input.date &&
          !input.entries.some(
            (e) =>
              e.therapistId === s.therapist &&
              e.department === s.type &&
              e.startTime === s.startTime &&
              e.endTime === s.endTime,
          ),
      )
    )
      throw new AppError(
        409,
        "이미 등록된 회기의 날짜·담당자·서비스·시간을 변경하는 시간표는 반영할 수 없습니다.",
      );
    operations.push(
      db.prepare("DELETE FROM schedule_entries WHERE date=?").bind(input.date),
    );
    const entries = input.entries.map((e) => ({
      ...e,
      weekday: "일월화수목금토"[new Date(`${e.date}T00:00:00Z`).getUTCDay()],
      importBatch: crypto.randomUUID(),
    }));
    operations.push(
      db
        .prepare(
          "INSERT INTO schedule_entries(id,date,weekday,department,therapist_id,therapist_name,start_time,end_time,treatment_code,import_batch) SELECT json_extract(value,'$.id'),json_extract(value,'$.date'),json_extract(value,'$.weekday'),json_extract(value,'$.department'),json_extract(value,'$.therapistId'),json_extract(value,'$.therapistName'),json_extract(value,'$.startTime'),json_extract(value,'$.endTime'),json_extract(value,'$.treatmentCode'),json_extract(value,'$.importBatch') FROM json_each(?)",
        )
        .bind(JSON.stringify(entries)),
    );
    detail = `시간표 ${input.entries.length}회기 반영`;
  } else {
    operations.push(
      db
        .prepare(
          "INSERT INTO system_settings(key,value) VALUES ('notice_template',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP",
        )
        .bind(input.value),
    );
  }
  try {
    await commit(
      db,
      input.version,
      operations,
      actor,
      input.kind,
      target,
      detail,
    );
  } catch {
    throw new AppError(
      409,
      "변경 사항을 저장하지 못했습니다. 다른 담당자의 변경이나 저장소 상태를 확인하고 새로고침해 주세요.",
    );
  }
  return { ok: true };
}
