import { parseCsv, participantImport, scheduleImport } from "./csv";
import {
  aliasSchema,
  therapistSchema,
  displayCodeSchema,
  dateSchema,
  timeSchema,
  therapySchema,
  today,
  clock,
  minutes,
  validSession,
  requestIntervals,
  emptyState,
  type State,
  type Participant,
  type ParticipantRequest,
  type ScheduleEntry,
  type ScheduleStaff,
} from "./domain";

export class ImportIssue extends Error {
  constructor(
    public row: number,
    public column: string,
    public detail: string,
  ) {
    super(`${row ? `${row}행 · ` : ""}${column}: ${detail}`);
  }
}
export type ImportOptions = {
  firstTime?: string;
  step?: number;
  cells?: "starts" | "filled";
  therapies?: Record<string, string>;
  statuses?: Record<string, ParticipantRequest["status"]>;
};
export type ParticipantPreview = ReturnType<typeof participantImport> & {
  format: string;
  sourceCount: number;
};
export type SchedulePreview = {
  kind: "schedule_import";
  date: string;
  dates: string[];
  entries: ScheduleEntry[];
  staff: ScheduleStaff[];
  warnings: string[];
  format: string;
  sourceCount: number;
};
export type CsvPreview = ParticipantPreview | SchedulePreview;
const headerName = (s: string) => s.replace(/\s+/g, "");
function rowsFor(text: string, required: string[]) {
  const [header, ...rows] = parseCsv(text, true);
  const normalized = header.map(headerName);
  const indexes = required.map((name) => {
    const i = normalized.indexOf(headerName(name));
    if (i < 0)
      throw new ImportIssue(1, name, "기관 양식의 열을 찾지 못했습니다.");
    if (normalized.lastIndexOf(headerName(name)) !== i)
      throw new ImportIssue(1, name, "같은 의미의 열이 중복되어 있습니다.");
    return i;
  });
  return { header, rows, indexes };
}
export function institutionDate(raw: string, row: number, column: string) {
  const match = raw
    .trim()
    .match(
      /^(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})(?:\s*일)?\.?/,
    );
  const value = match
    ? `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`
    : "";
  if (!dateSchema.safeParse(value).success)
    throw new ImportIssue(
      row,
      column,
      "연·월·일이 있는 실제 날짜를 확인하세요.",
    );
  const tail = raw.trim().slice(match![0].length).trim();
  if (
    column !== "타임스탬프" &&
    tail &&
    !/^\(?[일월화수목금토](?:요일)?\)?$/.test(tail)
  )
    throw new ImportIssue(row, column, "한 셀에는 날짜 하나만 입력하세요.");
  return value;
}
function submittedTime(raw: string, row: number) {
  const date = institutionDate(raw, row, "타임스탬프");
  const datePart = raw
    .trim()
    .match(
      /^(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})(?:\s*일)?\.?/,
    )![0];
  const tail = raw.trim().slice(datePart.length).trim();
  if (!tail) return `${date}T00:00:00+09:00`;
  const t = tail.match(
    /^T?(오전|오후|AM|PM)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(오전|오후|AM|PM)?(?:\+09:00)?$/i,
  );
  if (!t)
    throw new ImportIssue(
      row,
      "타임스탬프",
      "날짜 뒤 시각을 확인하세요. 예: 2026. 9. 17. 오후 1:30:00",
    );
  let hour = Number(t[2]);
  const period = (t[1] || t[5] || "").toUpperCase();
  if (period && (hour < 1 || hour > 12))
    throw new ImportIssue(
      row,
      "타임스탬프",
      "오전·오후 시각은 1~12시를 사용하세요.",
    );
  if (period) hour = (hour % 12) + (["오후", "PM"].includes(period) ? 12 : 0);
  const time = `${String(hour).padStart(2, "0")}:${t[3]}`;
  if (!timeSchema.safeParse(time).success || Number(t[4] ?? 0) > 59)
    throw new ImportIssue(row, "타임스탬프", "시·분·초 범위를 확인하세요.");
  return `${date}T${time}:${t[4] || "00"}+09:00`;
}
function therapy(raw: string, row: number, options: ImportOptions) {
  const aliases: Record<string, string> = {
    작업: "작업치료",
    OT: "작업치료",
    물리: "물리치료",
    PT: "물리치료",
    언어: "언어치료",
    ST: "언어치료",
    감각: "감각통합",
    감각통합치료: "감각통합",
    SI: "감각통합",
  };
  const value =
    options.therapies?.[raw] ||
    aliases[raw.replace(/\s+/g, "").toUpperCase()] ||
    raw.replace(/\s+/g, "");
  const parsed = therapySchema.safeParse(value);
  if (!parsed.success)
    throw new ImportIssue(
      row,
      "치료/부서",
      "아래 ‘기관 표현 연결’에서 이 표현의 치료 종류를 선택하세요.",
    );
  return parsed.data;
}
function safeDisplay(raw: string, row: number, column: string) {
  const value = displayCodeSchema.safeParse(raw);
  if (!value.success)
    throw new ImportIssue(
      row,
      column,
      "빈 값 또는 너무 긴 표시입니다. 1~80자의 익명 표시를 사용하세요.",
    );
  if (
    /^[*\sXx○●•-]+$/.test(value.data) ||
    /^(?:익명|비공개|삭제)$/.test(value.data)
  )
    throw new ImportIssue(
      row,
      column,
      "대상자를 구별할 수 없는 표시입니다. 사람마다 유지되는 익명 코드를 사용하세요.",
    );
  return value.data;
}
function timeToken(raw: string, period: "오전" | "오후", row: number) {
  const s = raw.trim();
  const m = s.match(
    /^(오전|오후)?\s*(\d{1,2})(?::(\d{2})|\s*시(?:\s*(\d{1,2})\s*분)?)(?:\s*분)?$/,
  );
  if (!m)
    throw new ImportIssue(
      row,
      period,
      "시각을 해석하지 못했습니다. 예: 09:00, 오전 9시, 09:00~11:00",
    );
  let h = Number(m[2]);
  const p = m[1] || period;
  if (h <= 12 && p === "오후" && h < 12) h += 12;
  if (m[1] === "오전" && h === 12) h = 0;
  const value = `${String(h).padStart(2, "0")}:${(m[3] || m[4] || "0").padStart(2, "0")}`;
  if (!timeSchema.safeParse(value).success)
    throw new ImportIssue(row, period, "시각 범위를 확인하세요.");
  return value;
}
export function institutionTimes(
  raw: string,
  period: "오전" | "오후",
  row: number,
) {
  if (!raw.trim() || /^(없음|불가|해당없음|-)$/.test(raw.trim())) return "";
  if (/^(전체|모두|전체 가능|모두 가능|오전 전체|오후 전체)$/.test(raw.trim()))
    return period === "오전" ? "08:30–12:00" : "13:00–18:00";
  const normalized = raw
    .split(/[,;\n·]/)
    .filter((s) => s.trim())
    .map((part) => {
      const pair = part.trim().split(/\s*[~–—-]\s*/);
      if (pair.length > 2)
        throw new ImportIssue(
          row,
          period,
          "시간 범위의 시작과 종료를 확인하세요.",
        );
      return pair.map((t) => timeToken(t, period, row)).join("–");
    })
    .join(", ");
  let ranges;
  try {
    ranges = requestIntervals(normalized);
  } catch {
    throw new ImportIssue(
      row,
      period,
      "종료 시각은 시작 시각 이후여야 합니다.",
    );
  }
  const start = period === "오전" ? 510 : 780,
    end = period === "오전" ? 720 : 1080;
  if (ranges.some((r) => minutes(r.start) < start || minutes(r.end) > end))
    throw new ImportIssue(
      row,
      period,
      "오전은 08:30~12:00, 오후는 13:00~18:00 안에서 선택하세요.",
    );
  return normalized;
}

export function importParticipantsCsv(
  text: string,
  state: State = emptyState,
  options: ImportOptions = {},
): ParticipantPreview {
  if (!parseCsv(text, true)[0].map(headerName).includes("아동이름"))
    return {
      ...participantImport(text),
      format: "표준 대기명단",
      sourceCount: parseCsv(text).length - 1,
    };
  const { rows, indexes } = rowsFor(text, [
    "타임스탬프",
    "아동이름",
    "아동 생년월일",
    "보강치료 희망 날짜",
    "치료",
    "오전",
    "오후",
    "비고",
  ]);
  if (rows.length > 1000)
    throw new ImportIssue(0, "파일", "한 번에 1,000행 이하로 반영하세요.");
  const ids = new Map<string, string>();
  const requests = new Map<string, ParticipantRequest>();
  const labels = new Map<string, string>();
  const warnings = new Set<string>([
    "익명 표시가 같은 아동은 같은 대상자로 연결됩니다. 표시가 사람별로 구별되고 재내보내기에도 유지되는지 확인하세요.",
    "생년월일과 비고 원문은 저장하지 않습니다. 대기 기간은 보강 신청일 기준입니다.",
  ]);
  const canonicalStatuses: Record<string, ParticipantRequest["status"]> = {
    "처리 대기": "처리 대기",
    완료: "처리 완료",
    "처리 완료": "처리 완료",
    공지: "안내 완료",
    "안내 완료": "안내 완료",
    자리없음: "추가 확인 필요",
    타임수초과: "추가 확인 필요",
    "추가 확인 필요": "추가 확인 필요",
    취소: "신청 취소",
    "신청 취소": "신청 취소",
    만료: "만료",
  };
  for (const [index, values] of rows.entries()) {
    const row = index + 2;
    const [stamp, name, , desired, treatments, am, pm, note] = indexes.map(
      (i) => values[i],
    );
    const label = safeDisplay(name, row, "아동이름");
    if (!ids.has(label)) {
      const known =
        state.participants.find(
          (p) => p.importSource === "institution" && p.externalCode === label,
        ) || state.participants.find((p) => p.id === label);
      ids.set(
        label,
        known?.id ||
          (aliasSchema.safeParse(label).success
            ? label
            : `대기자-${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`),
      );
    }
    const id = ids.get(label)!;
    labels.set(id, label);
    const timestamp = submittedTime(stamp, row),
      date = institutionDate(desired, row, "보강치료 희망 날짜");
    if (timestamp.slice(0, 10) > today())
      throw new ImportIssue(row, "타임스탬프", "신청일이 오늘 이후입니다.");
    const types = [
      ...new Set(
        treatments
          .split(/[,·/;\n]/)
          .map((s) => therapy(s.trim(), row, options)),
      ),
    ]
      .sort()
      .join(", ");
    const morningTimes = institutionTimes(am, "오전", row),
      afternoonTimes = institutionTimes(pm, "오후", row);
    if (!morningTimes && !afternoonTimes)
      throw new ImportIssue(
        row,
        "오전/오후",
        "희망 시간 중 하나 이상이 필요합니다.",
      );
    const status = !note.trim()
      ? "처리 대기"
      : options.statuses?.[note.trim()] || canonicalStatuses[note.trim()];
    if (!status)
      throw new ImportIssue(
        row,
        "비고",
        "상태를 자동 판단할 수 없습니다. 아래 ‘기관 표현 연결’에서 처리 상태를 선택하세요.",
      );
    const requestId = `${id}|${date}|${types}`;
    let r: ParticipantRequest = {
      id: requestId,
      participantId: id,
      submittedAt: timestamp.slice(0, 10),
      submittedTime: timestamp,
      desiredDate: date,
      therapyTypes: types,
      morningTimes,
      afternoonTimes,
      status,
      note: "",
      preserveStatus: !note.trim(),
    };
    const previous = requests.get(requestId);
    if (previous) {
      if (
        previous.submittedTime === r.submittedTime &&
        (previous.morningTimes !== morningTimes ||
          previous.afternoonTimes !== afternoonTimes ||
          previous.status !== status)
      )
        throw new ImportIssue(
          row,
          "중복 신청",
          "같은 시각에 접수된 동일 아동·날짜·치료의 내용이 다릅니다.",
        );
      warnings.add(
        "같은 아동·희망 날짜·치료의 반복 행은 최신 신청 1건으로 반영합니다.",
      );
      if (previous.submittedTime! > timestamp) continue;
    }
    const stored = state.participantRequests.find(
      (old) => old.id === requestId,
    );
    if (stored?.submittedTime && stored.submittedTime > timestamp) {
      warnings.add(`${row}행: 저장된 더 최신 신청을 유지합니다.`);
      r = stored;
    } else if (stored && (r.preserveStatus || r.status === "처리 대기"))
      r = { ...r, status: stored.status };
    if (date < today())
      warnings.add(
        `${row}행: 지난 희망 날짜입니다. 기록은 가져오지만 후보에서는 제외됩니다.`,
      );
    requests.set(requestId, r);
  }
  const people: Participant[] = [];
  for (const [id, externalCode] of labels) {
    const rs = [...requests.values()].filter((r) => r.participantId === id);
    const existing = state.participants.find((p) => p.id === id);
    const allIntervals = rs.flatMap((r) => [
      ...requestIntervals(r.morningTimes),
      ...requestIntervals(r.afternoonTimes),
    ]);
    const intervals = [
      ...new Map(allIntervals.map((i) => [`${i.start}-${i.end}`, i])).values(),
    ];
    people.push({
      id,
      externalCode: existing?.externalCode || externalCode,
      importSource: existing?.externalCode
        ? existing.importSource
        : "institution",
      type: [...new Set(rs.flatMap((r) => r.therapyTypes.split(", ")))]
        .sort()
        .join(", "),
      availability: JSON.stringify({
        weekdays: [
          ...new Set(
            rs.map((r) => new Date(`${r.desiredDate}T00:00:00Z`).getUTCDay()),
          ),
        ],
        intervals,
      }),
      since: rs.map((r) => r.submittedAt).sort()[0],
      recent: existing?.recent ?? "없음",
      active: existing?.active ?? true,
    });
    if (existing?.active === false)
      warnings.add("중지된 대기자의 상태를 유지합니다.");
  }
  return {
    kind: "participants_import",
    participants: people,
    requests: [...requests.values()],
    warnings: [...warnings],
    format: "기관 보강치료 신청명단",
    sourceCount: rows.length,
  };
}

export function importScheduleCsv(
  text: string,
  state: State = emptyState,
  options: ImportOptions = {},
): SchedulePreview {
  const headers = parseCsv(text, true)[0];
  if (headers.includes("담당자 코드")) {
    const original = scheduleImport(text);
    return {
      ...original,
      dates: [original.date],
      staff: [],
      format: "표준 시간표",
      sourceCount: parseCsv(text).length - 1,
    };
  }
  const { header, rows, indexes } = rowsFor(text, [
    "일자",
    "요일",
    "부서",
    "아이디",
    "치료사",
    "건수",
  ]);
  if (rows.length > 500)
    throw new ImportIssue(
      0,
      "파일",
      "시간표는 한 번에 500행 이하로 반영하세요.",
    );
  const timeStart = indexes[5] + 1;
  if (timeStart >= header.length)
    throw new ImportIssue(1, "시간 열", "건수 뒤의 시간별 예약 열이 없습니다.");
  const timeHeaders = header.slice(timeStart);
  let times = timeHeaders.map((h) => {
    const match =
      h.trim().match(/^(\d{1,2}):(\d{2})(?::00)?$/) ||
      h.trim().match(/^(\d{1,2})시\s*(\d{1,2})분?$/);
    return match
      ? `${match[1].padStart(2, "0")}:${match[2].padStart(2, "0")}`
      : "";
  });
  if (times.some((t) => !timeSchema.safeParse(t).success)) {
    if (
      !options.firstTime ||
      !timeSchema.safeParse(options.firstTime).success ||
      ![10, 30].includes(options.step ?? 0)
    )
      throw new ImportIssue(
        1,
        "시간 열",
        "시간 제목을 읽지 못했습니다. 아래에서 첫 시간과 열 간격을 확인한 뒤 다시 분석하세요.",
      );
    times = times.map((existing, i) => {
      const expected = clock(minutes(options.firstTime!) + i * options.step!);
      if (
        !timeSchema.safeParse(expected).success ||
        (existing && existing !== expected)
      )
        throw new ImportIssue(
          1,
          "시간 열",
          "지정한 시작·간격과 실제 시간 제목이 일치하지 않습니다.",
        );
      return expected;
    });
  }
  if (
    new Set(times).size !== times.length ||
    times.some((t, i) => i > 0 && minutes(t) <= minutes(times[i - 1]))
  )
    throw new ImportIssue(
      1,
      "시간 열",
      "중복 없이 이른 시간부터 나열되어야 합니다.",
    );
  const staff = new Map<string, ScheduleStaff>(),
    entries: ScheduleEntry[] = [],
    seen = new Set<string>();
  const warnings = new Set<string>([
    "선택한 날짜의 시간표를 교체합니다. 이미 등록된 결석·연결 회기는 보존되어야 합니다.",
  ]);
  for (const [index, values] of rows.entries()) {
    const row = index + 2;
    const [rawDate, weekday, department, external, name, count] = indexes.map(
      (i) => values[i],
    );
    const date = institutionDate(rawDate, row, "일자"),
      externalCode = safeDisplay(external, row, "아이디"),
      displayName = safeDisplay(name, row, "치료사"),
      type = therapy(department, row, options);
    const known = state.staff?.find((s) => s.externalCode === externalCode);
    const id =
      staff.get(externalCode)?.id ||
      known?.id ||
      (therapistSchema.safeParse(externalCode).success
        ? externalCode
        : `TH-${crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`);
    const existing = staff.get(externalCode);
    if (
      existing &&
      (existing.displayName !== displayName || existing.department !== type)
    )
      throw new ImportIssue(
        row,
        "아이디/치료사",
        "같은 아이디에 다른 치료사 표시나 부서가 있습니다.",
      );
    staff.set(externalCode, {
      id,
      externalCode,
      displayName,
      department: type,
      position: existing?.position ?? index,
    });
    const computedDay = "일월화수목금토"[
      new Date(`${date}T00:00:00Z`).getUTCDay()
    ];
    if (weekday && !weekday.includes(computedDay))
      warnings.add(`${row}행: 요일을 일자에 맞춰 표시합니다.`);
    let bookings = 0;
    for (let col = 0; col < times.length; col++) {
      const code = values[timeStart + col]?.trim();
      if (!code || code === "-") continue;
      const start = times[col],
        end = clock(minutes(start) + 30);
      if (!validSession(start, end))
        throw new ImportIssue(
          row,
          `${start} 예약`,
          "30분 시작 기준과 맞지 않습니다. 예약이 10분 칸에 반복되는 양식이면 아래에서 ‘회기 전체 칸 반복’을 선택하세요.",
        );
      if (options.cells === "filled") {
        let next = col + 1;
        while (next < times.length && minutes(times[next]) < minutes(end)) {
          if (values[timeStart + next]?.trim() !== code)
            throw new ImportIssue(
              row,
              `${start} 예약`,
              "반복 예약 칸의 코드가 다릅니다. 시작 칸만 사용하는 양식인지 확인하세요.",
            );
          next++;
        }
        if (
          next === times.length &&
          times.length > 1 &&
          minutes(times.at(-1)!) +
            (minutes(times.at(-1)!) - minutes(times.at(-2)!)) <
            minutes(end)
        )
          throw new ImportIssue(
            row,
            `${start} 예약`,
            "회기 종료 전 시간 열이 끝납니다.",
          );
        col = next - 1;
      }
      const entryId = `${date}|${id}|${start}`;
      if (seen.has(entryId))
        throw new ImportIssue(
          row,
          start,
          "같은 날짜·치료사·시간 예약이 중복됩니다.",
        );
      seen.add(entryId);
      bookings++;
      entries.push({
        id: entryId,
        date,
        weekday: computedDay,
        department: type,
        therapistId: id,
        therapistName: displayName,
        startTime: start,
        endTime: end,
        treatmentCode: safeDisplay(code, row, start),
        importBatch: crypto.randomUUID(),
      });
    }
    if (count && /^\d+$/.test(count) && Number(count) !== bookings)
      warnings.add(
        `${row}행: 원본 건수 ${count}건 / 해석한 예약 ${bookings}건을 확인하세요.`,
      );
  }
  if (!entries.length)
    throw new ImportIssue(
      0,
      "예약",
      "반영할 예약이 없습니다. 빈 셀은 결석으로 등록하지 않습니다.",
    );
  if (entries.length > 500)
    throw new ImportIssue(0, "예약", "한 번에 500회기 이하로 반영하세요.");
  const dates = [...new Set(entries.map((e) => e.date))].sort();
  return {
    kind: "schedule_import",
    date: dates[0],
    dates,
    entries,
    staff: [...staff.values()],
    warnings: [...warnings],
    format: "기관 익명 치료 현황판",
    sourceCount: rows.length,
  };
}

// Only transient column expressions are returned; birthdates are never read here.
export function importExpressions(
  text: string,
  kind: "participants" | "schedule",
) {
  const [header, ...rows] = parseCsv(text, true);
  const typeIndex = header.findIndex(
    (h) => headerName(h) === (kind === "participants" ? "치료" : "부서"),
  );
  const statusIndex = header.findIndex((h) => headerName(h) === "비고");
  return {
    therapies: [
      ...new Set(
        rows
          .flatMap((r) =>
            (r[typeIndex] || "").split(/[,·/;\n]/).map((s) => s.trim()),
          )
          .filter(Boolean),
      ),
    ],
    // Notes are shown as row numbers; their contents never enter labels or logs.
    statusRows:
      statusIndex < 0
        ? []
        : rows.flatMap((r, i) =>
            r[statusIndex]?.trim()
              ? [{ row: i + 2, value: r[statusIndex].trim() }]
              : [],
          ),
  };
}
