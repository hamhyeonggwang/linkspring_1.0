import { z } from "zod";

export const therapyTypes = [
  "작업치료",
  "물리치료",
  "언어치료",
  "감각통합",
  "상담",
  "교육",
  "가족지원",
] as const;
export const therapySchema = z.enum(therapyTypes);
export const noticeTemplates = [
  "안녕하세요. {날짜} {시간} {치료종류} 이용 기회를 안내드립니다. 참여 가능 여부를 담당자에게 회신해 주세요.",
  "{날짜} {시간} {치료종류} 일정이 가능해 안내드립니다. 참여를 원하시면 기관 담당자에게 연락해 주세요.",
] as const;
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === v;
  }, "실제 존재하는 날짜를 입력하세요.");
export const timeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export function today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
export function sessionNotStarted(
  slot: { date: string; startTime: string },
  now = new Date(),
) {
  return Date.parse(`${slot.date}T${slot.startTime}:00+09:00`) > now.valueOf();
}
export function minutes(v: string) {
  return Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5));
}
export function clock(v: number) {
  return `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
}
export function validSession(start: string, end: string) {
  return (
    timeSchema.safeParse(start).success &&
    timeSchema.safeParse(end).success &&
    minutes(end) - minutes(start) === 30 &&
    minutes(start) % 30 === 0 &&
    minutes(start) >= 510 &&
    minutes(end) <= 1080 &&
    !(minutes(start) < 780 && minutes(end) > 720)
  );
}
export const sessionTimes = Array.from({ length: 19 }, (_, i) =>
  clock(510 + i * 30),
).filter((t) => validSession(t, clock(minutes(t) + 30)));
const shortText = z.string().trim().min(1).max(80);
export const aliasSchema = z
  .string()
  .regex(
    /^(?:아동|대기자)-[A-Z0-9]{4,32}$/,
    "가명 ID는 대기자-AB1234 형식을 사용하세요.",
  );
export const therapistSchema = z
  .string()
  .regex(
    /^[A-Z]{2,12}-[A-Z0-9]{1,16}$/,
    "담당자 코드(예: OT-01)를 입력하세요.",
  );
export const intervalSchema = z
  .object({ start: timeSchema, end: timeSchema })
  .refine(
    (v) => minutes(v.start) < minutes(v.end),
    "종료 시간은 시작 시간 이후여야 합니다.",
  );
export const availabilitySchema = z.object({
  weekdays: z.array(z.number().int().min(0).max(6)).min(1),
  intervals: z.array(intervalSchema).min(1),
});
export type Availability = z.infer<typeof availabilitySchema>;
export function parseAvailability(value: string): Availability | null {
  try {
    const parsed = availabilitySchema.safeParse(JSON.parse(value));
    if (parsed.success) return parsed.data;
  } catch {}
  const weekdays = value.includes("평일")
    ? [1, 2, 3, 4, 5]
    : value.includes("매일")
      ? [0, 1, 2, 3, 4, 5, 6]
      : [..."일월화수목금토"].flatMap((d, i) => (value.includes(d) ? [i] : []));
  const intervals = [
    ...value.matchAll(/(\d{2}:\d{2})\s*[–~\-]\s*(\d{2}:\d{2})/g),
  ].map((m) => ({ start: m[1], end: m[2] }));
  const parsed = availabilitySchema.safeParse({ weekdays, intervals });
  return parsed.success ? parsed.data : null;
}
export function availabilityLabel(value: string) {
  const v = parseAvailability(value);
  return v
    ? `${v.weekdays.map((d) => "일월화수목금토"[d]).join("·")} ${v.intervals.map((t) => `${t.start}–${t.end}`).join(", ")}`
    : "가능 시간 확인 필요";
}
export const participantSchema = z.object({
  id: aliasSchema,
  type: z
    .string()
    .refine((v) =>
      v.split(", ").every((t) => therapySchema.safeParse(t).success),
    ),
  availability: z
    .string()
    .max(2000)
    .refine(
      (v) => parseAvailability(v) !== null,
      "요일과 가능 시간 범위를 확인하세요.",
    ),
  since: dateSchema,
  recent: z.union([dateSchema, z.literal("없음")]).default("없음"),
  active: z.boolean(),
});
export type Participant = z.infer<typeof participantSchema>;
export const requestSchema = z.object({
  id: shortText.max(140),
  participantId: aliasSchema,
  submittedAt: dateSchema,
  desiredDate: dateSchema,
  therapyTypes: z
    .string()
    .refine((v) =>
      v.split(", ").every((t) => therapySchema.safeParse(t).success),
    ),
  morningTimes: z.string().max(1000),
  afternoonTimes: z.string().max(1000),
  status: z.enum([
    "처리 대기",
    "처리 완료",
    "안내 완료",
    "추가 확인 필요",
    "신청 취소",
    "만료",
  ]),
  note: z.literal("").default(""),
});
export type ParticipantRequest = z.infer<typeof requestSchema>;
export const scheduleSchema = z
  .object({
    id: shortText.max(140),
    date: dateSchema,
    weekday: z.string().max(3),
    department: therapySchema,
    therapistId: therapistSchema,
    therapistName: therapistSchema,
    startTime: timeSchema,
    endTime: timeSchema,
    treatmentCode: z.string().regex(/^[A-Z0-9_-]{1,24}$/),
    importBatch: z.string().max(80),
  })
  .refine(
    (v) => validSession(v.startTime, v.endTime),
    "운영 시간 내 30분 회기만 가능합니다.",
  );
export type ScheduleEntry = z.infer<typeof scheduleSchema>;
export const slotInputSchema = z
  .object({
    date: dateSchema,
    startTime: timeSchema,
    endTime: timeSchema,
    type: therapySchema,
    therapist: therapistSchema,
  })
  .refine(
    (v) => validSession(v.startTime, v.endTime),
    "08:30–12:00 / 13:00–18:00의 30분 회기를 입력하세요.",
  );
export type SlotInput = z.infer<typeof slotInputSchema>;
export type Slot = SlotInput & {
  id: string;
  status: string;
  assignedParticipant: string | null;
  noticeStatus: string;
  noticeText: string;
  assignedAt: string | null;
  noticeCompletedAt: string | null;
  revision: number;
};
export type Audit = {
  id: number;
  slotId: string;
  action: string;
  actor: string;
  detail: string;
  createdAt: string;
};
export type State = {
  slots: Slot[];
  participants: Participant[];
  participantRequests: ParticipantRequest[];
  scheduleEntries: ScheduleEntry[];
  audit: Audit[];
  settings: Record<string, string>;
};
export const emptyState: State = {
  slots: [],
  participants: [],
  participantRequests: [],
  scheduleEntries: [],
  audit: [],
  settings: {},
};
export function overlap(a: string, b: string, c: string, d: string) {
  return minutes(a) < minutes(d) && minutes(c) < minutes(b);
}
export function requestIntervals(text: string) {
  const result: z.infer<typeof intervalSchema>[] = [];
  for (const raw of text
    .split(/[,;\n]/)
    .map((t) => t.trim())
    .filter(Boolean)) {
    const range = raw.match(/^(\d{2}:\d{2})\s*[–~\-]\s*(\d{2}:\d{2})$/);
    const single = timeSchema.safeParse(raw);
    const parsed = intervalSchema.safeParse(
      range
        ? { start: range[1], end: range[2] }
        : single.success
          ? { start: raw, end: clock(minutes(raw) + 30) }
          : null,
    );
    if (!parsed.success)
      throw new Error("가능 시간은 HH:mm 또는 HH:mm–HH:mm 형식이어야 합니다.");
    result.push(parsed.data);
  }
  return result;
}
export type Candidate = {
  participant: Participant;
  waiting: number;
  recent: string;
  exact: boolean;
  alternativeStarts: string[];
  reason: string;
};
export function candidatesFor(
  slot: SlotInput,
  state: State,
  tolerance = 0,
): Candidate[] {
  if (!sessionNotStarted(slot)) return [];
  const weekday = new Date(`${slot.date}T00:00:00Z`).getUTCDay();
  return state.participants
    .flatMap((p) => {
      if (
        !p.active ||
        p.since > slot.date ||
        !p.type.split(", ").includes(slot.type)
      )
        return [];
      const requests = state.participantRequests.filter(
        (r) => r.participantId === p.id,
      );
      let intervals: z.infer<typeof intervalSchema>[] = [];
      if (requests.length) {
        try {
          intervals = requests
            .filter(
              (r) =>
                r.desiredDate === slot.date &&
                r.status === "처리 대기" &&
                r.therapyTypes.split(", ").includes(slot.type),
            )
            .flatMap((r) => [
              ...requestIntervals(r.morningTimes),
              ...requestIntervals(r.afternoonTimes),
            ]);
        } catch {
          return [];
        }
      } else {
        const a = parseAvailability(p.availability);
        if (a?.weekdays.includes(weekday)) intervals = a.intervals;
      }
      const fits = (start: string) =>
        intervals.some(
          (i) =>
            minutes(i.start) <= minutes(start) &&
            minutes(i.end) >= minutes(start) + 30,
        ) &&
        !state.slots.some(
          (s) =>
            s.status === "연결 완료" &&
            s.assignedParticipant === p.id &&
            s.date === slot.date &&
            overlap(s.startTime, s.endTime, start, clock(minutes(start) + 30)),
        );
      const exact = fits(slot.startTime);
      const alternativeStarts = exact
        ? []
        : sessionTimes.filter(
            (t) =>
              Math.abs(minutes(t) - minutes(slot.startTime)) <= tolerance &&
              fits(t),
          );
      if (!exact && !alternativeStarts.length) return [];
      const history = state.slots
        .filter(
          (s) => s.status === "연결 완료" && s.assignedParticipant === p.id,
        )
        .map((s) => s.date);
      const recent =
        [...(p.recent !== "없음" ? [p.recent] : []), ...history]
          .sort()
          .at(-1) ?? "없음";
      return [
        {
          participant: p,
          waiting: Math.max(
            0,
            Math.floor(
              (Date.parse(`${slot.date}T00:00:00Z`) -
                Date.parse(`${p.since}T00:00:00Z`)) /
                86400000,
            ),
          ),
          recent,
          exact,
          alternativeStarts,
          reason: exact
            ? "서비스 유형·날짜·30분 전체 시간 일치"
            : "인접 시간만 가능 · 시간 재협의 필요",
        },
      ];
    })
    .sort(
      (a, b) =>
        Number(b.exact) - Number(a.exact) ||
        b.waiting - a.waiting ||
        (a.recent === "없음" ? "" : a.recent).localeCompare(
          b.recent === "없음" ? "" : b.recent,
        ) ||
        a.participant.id.localeCompare(b.participant.id),
    );
}

// Allowlisting schedule tokens avoids forwarding names, contact details, or free-text health information.
export function scheduleTokens(text: string) {
  const cleaned = text.replace(
    /(?:생년월일|생일|출생일|DOB)\s*[:：]?\s*[\d년월일.\-/ ]+/gi,
    "",
  );
  const tokens =
    cleaned.match(
      /\b(?:OT|PT|ST|SI|ED|SW)-\d{1,3}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}:\d{2}\b|(?:오전|오후)?\s*\d{1,2}\s*시(?:\s*\d{1,2}\s*분)?|오늘|내일|모레|이번\s*주|다음\s*주|[월화수목금토일]요일|작업치료|물리치료|언어치료|감각통합|상담|교육|가족지원/gi,
    ) ?? [];
  // Past absolute dates (including unlabelled birth dates) and month/day-only
  // dates are never forwarded. The coordinator can enter them manually.
  return tokens
    .map((t) => t.trim())
    .filter(
      (t) =>
        !/^\d{4}-/.test(t) || (dateSchema.safeParse(t).success && t >= today()),
    )
    .join(" ")
    .slice(0, 1000);
}
