import { z } from "zod";
import type { DatabasePort, PreparedQuery } from "./database-port";
import { AppError } from "./errors";
import { readState, commit } from "./state-store";
import {
  slotInputSchema,
  participantSchema,
  requestSchema,
  scheduleSchema,
  staffSchema,
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
  z.object({ kind: z.literal("notice_draft"), version: versionSchema, slotId: z.string().max(100), text: z.string().trim().min(1).max(1600), source: z.enum(["ai", "rules", "manual"]) }),
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
    dates: z.array(dateSchema).min(1).max(100).optional(),
    staff: z.array(staffSchema).max(500).optional(),
    preferences: z
      .object({
        firstTime: z
          .string()
          .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
          .optional(),
        step: z.union([z.literal(10), z.literal(30)]).optional(),
        cells: z.enum(["starts", "filled"]).optional(),
        therapies: z.record(z.string().max(80), z.string().max(40)).optional(),
      })
      .optional(),
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
  db: DatabasePort,
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
  const operations: PreparedQuery[] = [];
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
    input.kind === "notice" || input.kind === "notice_draft"
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
    } else if (input.kind === "notice_draft") {
      if (s.status !== "연결 완료" || s.noticeStatus === "안내 완료") throw new AppError(409, "안내 완료 전의 연결된 회기만 수정할 수 있습니다.");
      if (![s.date, s.startTime, s.endTime, s.type].every(v => input.text.includes(v))) throw new AppError(400, "안내문에 확정된 날짜·시작·종료 시각·서비스를 모두 포함해 주세요.");
      operations.push(db.prepare("UPDATE slots SET notice_text=?,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(input.text, target));
      detail = `${input.source === "ai" ? "AI 초안" : input.source === "rules" ? "기본 문구" : "직접 작성"} · 담당자 검토 후 안내문 저장`;
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
      externalCode:
        p.externalCode ??
        state.participants.find((old) => old.id === p.id)?.externalCode ??
        null,
      importSource:
        p.importSource ??
        state.participants.find((old) => old.id === p.id)?.importSource ??
        "manual",
      availability: JSON.stringify(parseAvailability(p.availability)),
      active: Number(
        input.kind === "participants_import"
          ? (state.participants.find((old) => old.id === p.id)?.active ??
              p.active)
          : p.active,
      ),
      type:
        input.kind === "participants_import"
          ? [
              ...new Set([
                ...(state.participants
                  .find((old) => old.id === p.id)
                  ?.type.split(", ") ?? []),
                ...p.type.split(", "),
              ]),
            ]
              .sort()
              .join(", ")
          : p.type,
      since:
        input.kind === "participants_import"
          ? [
              state.participants.find((old) => old.id === p.id)?.since ??
                p.since,
              p.since,
            ].sort()[0]
          : p.since,
    }));
    for (const p of normalized) {
      const existing = state.participants.find((old) => old.id === p.id);
      if (
        existing?.externalCode &&
        (existing.externalCode !== p.externalCode ||
          existing.importSource !== p.importSource)
      )
        throw new AppError(
          409,
          "기존 익명 표시와 대상자의 연결은 변경할 수 없습니다.",
        );
      if (
        p.externalCode &&
        state.participants.some(
          (old) =>
            old.id !== p.id &&
            old.externalCode === p.externalCode &&
            old.importSource === p.importSource,
        )
      )
        throw new AppError(
          409,
          "이미 등록된 익명 표시입니다. 새로고침 후 다시 가져오세요.",
        );
    }
    operations.push(
      db
        .prepare(
          "INSERT INTO participants(id,therapy_type,availability,waiting_since,recent_connection,active,external_code,import_source) SELECT json_extract(value,'$.id'),json_extract(value,'$.type'),json_extract(value,'$.availability'),json_extract(value,'$.since'),json_extract(value,'$.recent'),json_extract(value,'$.active'),json_extract(value,'$.externalCode'),json_extract(value,'$.importSource') FROM json_each(?) WHERE 1 ON CONFLICT(id) DO UPDATE SET therapy_type=excluded.therapy_type,availability=excluded.availability,waiting_since=excluded.waiting_since,active=excluded.active,external_code=excluded.external_code,import_source=excluded.import_source,updated_at=CURRENT_TIMESTAMP",
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
            "INSERT INTO participant_requests(id,participant_id,submitted_at,desired_date,therapy_types,morning_times,afternoon_times,status,note,submitted_time) SELECT json_extract(value,'$.id'),json_extract(value,'$.participantId'),json_extract(value,'$.submittedAt'),json_extract(value,'$.desiredDate'),json_extract(value,'$.therapyTypes'),json_extract(value,'$.morningTimes'),json_extract(value,'$.afternoonTimes'),json_extract(value,'$.status'),'',json_extract(value,'$.submittedTime') FROM json_each(?) WHERE 1 ON CONFLICT(id) DO UPDATE SET submitted_at=excluded.submitted_at,desired_date=excluded.desired_date,therapy_types=excluded.therapy_types,morning_times=excluded.morning_times,afternoon_times=excluded.afternoon_times,status=excluded.status,note='',submitted_time=excluded.submitted_time,updated_at=CURRENT_TIMESTAMP",
          )
          .bind(
            JSON.stringify(
              input.requests.map((r) => {
                const previous = state.participantRequests.find(
                  (old) => old.id === r.id,
                );
                if (
                  previous?.submittedTime &&
                  r.submittedTime &&
                  previous.submittedTime > r.submittedTime
                )
                  return previous;
                return {
                  ...r,
                  status:
                    previous && (r.preserveStatus || r.status === "처리 대기")
                      ? previous.status
                      : r.status,
                };
              }),
            ),
          ),
      );
    }
    detail = `대기자 ${people.length}명 반영`;
  } else if (input.kind === "schedule_import") {
    const dates = input.dates ?? [input.date];
    unique(dates);
    if (
      !dates.includes(input.date) ||
      dates.some((date) => !input.entries.some((e) => e.date === date))
    )
      throw new AppError(400, "반영할 날짜와 예약을 확인하세요.");
    target = dates.join(", ");
    unique(
      input.entries.map((e) => `${e.date}|${e.therapistId}|${e.startTime}`),
    );
    if (
      input.entries.some(
        (e) =>
          !dates.includes(e.date) ||
          e.id !== `${e.date}|${e.therapistId}|${e.startTime}`,
      )
    )
      throw new AppError(
        400,
        "동일 날짜의 익명 담당자 코드 시간표만 반영할 수 있습니다.",
      );
    if (
      state.slots.some(
        (s) =>
          dates.includes(s.date) &&
          !input.entries.some(
            (e) =>
              e.date === s.date &&
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
    for (const day of dates)
      operations.push(
        db.prepare("DELETE FROM schedule_entries WHERE date=?").bind(day),
      );
    const staff = input.staff ?? [];
    unique(staff.map((s) => s.id));
    unique(staff.map((s) => s.externalCode));
    for (const s of staff) {
      if (
        state.staff?.some(
          (old) =>
            (old.id === s.id && old.externalCode !== s.externalCode) ||
            (old.externalCode === s.externalCode && old.id !== s.id),
        )
      )
        throw new AppError(
          409,
          "치료사 코드가 이미 연결되어 있습니다. 새로고침 후 다시 가져오세요.",
        );
      operations.push(
        db
          .prepare(
            "INSERT INTO schedule_staff(id,external_code,display_name,department,position) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,department=excluded.department,position=excluded.position",
          )
          .bind(s.id, s.externalCode, s.displayName, s.department, s.position),
      );
    }
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
    if (input.preferences)
      operations.push(
        db
          .prepare(
            "INSERT INTO system_settings(key,value) VALUES ('csv_schedule_preferences',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          )
          .bind(JSON.stringify(input.preferences)),
      );
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
