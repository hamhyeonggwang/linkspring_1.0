import {
  participantSchema,
  requestSchema,
  scheduleSchema,
  requestIntervals,
  parseAvailability,
  therapySchema,
  dateSchema,
  today,
  clock,
  minutes,
  validSession,
  type Participant,
  type ParticipantRequest,
  type ScheduleEntry,
} from "./domain";

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === "," && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (quoted) throw new Error("CSV 따옴표가 닫히지 않았습니다.");
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  if (rows.length < 2) throw new Error("CSV에 데이터 행이 없습니다.");
  rows[0][0] = rows[0][0].replace(/^\uFEFF/, "");
  if (new Set(rows[0]).size !== rows[0].length)
    throw new Error("같은 이름의 열이 중복되어 있습니다.");
  if (rows.slice(1).some((r) => r.length !== rows[0].length))
    throw new Error("모든 행의 열 수가 같아야 합니다.");
  return rows;
}
export async function decodeCsv(file: File) {
  if (file.size > 1_000_000) throw new Error("CSV는 1MB 이하로 나누어 주세요.");
  const buffer = await file.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder("euc-kr", { fatal: true }).decode(buffer);
  }
}
function table(text: string, required: string[]) {
  const [header, ...rows] = parseCsv(text);
  for (const name of required)
    if (!header.includes(name)) throw new Error(`필수 열이 없습니다: ${name}`);
  return rows.map((r) => Object.fromEntries(header.map((k, i) => [k, r[i]])));
}
export function participantImport(text: string) {
  const rows = table(text, [
    "가명 ID",
    "치료",
    "대기 시작일",
    "희망 날짜",
    "오전",
    "오후",
    "상태",
  ]);
  if (rows.length > 1000)
    throw new Error("한 번에 1,000행 이하로 반영해 주세요.");
  const people = new Map<string, Participant>(),
    requests: ParticipantRequest[] = [],
    warnings: string[] = [],
    seen = new Set<string>();
  for (const [index, row] of rows.entries()) {
    try {
      const type = row["치료"]
        .split(/[,·]/)
        .map((t) => t.trim())
        .filter(Boolean)
        .map((t) => therapySchema.parse(t))
        .join(", ");
      const date = dateSchema.parse(row["희망 날짜"]),
        since = dateSchema.parse(row["대기 시작일"]);
      const intervals = [
        ...requestIntervals(row["오전"]),
        ...requestIntervals(row["오후"]),
      ];
      if (!intervals.length) throw new Error("희망 시간을 입력하세요.");
      const id = row["가명 ID"],
        requestId = `${id}|${date}|${type}`;
      if (seen.has(requestId))
        throw new Error(
          "같은 대기자·날짜·서비스의 중복 행입니다. 시간은 한 행에 합쳐 주세요.",
        );
      seen.add(requestId);
      const status = row["상태"] || "처리 대기";
      const r = requestSchema.parse({
        id: requestId,
        participantId: id,
        submittedAt: since,
        desiredDate: date,
        therapyTypes: type,
        morningTimes: row["오전"],
        afternoonTimes: row["오후"],
        status,
        note: "",
      });
      if (date < today())
        warnings.push(`${index + 2}행: 지난 날짜이므로 후보에서 제외됩니다.`);
      const previous = people.get(id),
        weekday = new Date(`${date}T00:00:00Z`).getUTCDay(),
        old = previous ? parseAvailability(previous.availability) : null;
      const p = participantSchema.parse({
        id,
        type: [
          ...new Set([
            ...(previous?.type.split(", ") ?? []),
            ...type.split(", "),
          ]),
        ].join(", "),
        availability: JSON.stringify({
          weekdays: [...new Set([...(old?.weekdays ?? []), weekday])],
          intervals: [...(old?.intervals ?? []), ...intervals],
        }),
        since: previous && previous.since < since ? previous.since : since,
        recent: "없음",
        active: true,
      });
      if (p.since > today()) throw new Error("대기 시작일이 미래입니다.");
      people.set(id, p);
      requests.push(r);
    } catch (error) {
      throw new Error(
        `${index + 2}행: ${error instanceof Error && !("issues" in error) ? error.message : "가명 ID·날짜·서비스·상태 형식을 확인하세요."}`,
      );
    }
  }
  warnings.push(
    "같은 가명 ID는 갱신합니다. 희망 일정은 가명 ID·날짜·서비스 단위로 갱신하며, CSV에 없는 기존 신청은 유지합니다.",
  );
  return {
    kind: "participants_import" as const,
    participants: [...people.values()],
    requests,
    warnings,
  };
}
export function scheduleImport(text: string) {
  const rows = table(text, [
    "일자",
    "부서",
    "담당자 코드",
    "시작",
    "종료",
    "예약 코드",
  ]);
  if (rows.length > 500)
    throw new Error("한 번에 500회기 이하로 반영해 주세요.");
  const entries: ScheduleEntry[] = [],
    seen = new Set<string>(),
    warnings: string[] = [];
  let date = "";
  for (const [index, r] of rows.entries()) {
    const day = r["일자"];
    date ||= day;
    if (day !== date)
      throw new Error(
        `${index + 2}행: 여러 날짜가 있습니다. 날짜별로 나누어 가져오세요.`,
      );
    const id = `${day}|${r["담당자 코드"]}|${r["시작"]}`;
    if (seen.has(id))
      throw new Error(`${index + 2}행: 담당자·시간이 중복됩니다.`);
    seen.add(id);
    const e = scheduleSchema.safeParse({
      id,
      date: day,
      weekday: "일월화수목금토"[new Date(`${day}T00:00:00Z`).getUTCDay()] ?? "",
      department: r["부서"],
      therapistId: r["담당자 코드"],
      therapistName: r["담당자 코드"],
      startTime: r["시작"],
      endTime: r["종료"],
      treatmentCode: r["예약 코드"],
      importBatch: crypto.randomUUID(),
    });
    if (!e.success)
      throw new Error(
        `${index + 2}행: 날짜·익명 담당자 코드·서비스 또는 30분 운영 시간을 확인하세요.`,
      );
    entries.push(e.data);
  }
  warnings.push(
    "동일 날짜 시간표 전체를 교체합니다. 이미 등록한 회기는 유지되어야 합니다.",
  );
  return { kind: "schedule_import" as const, date, entries, warnings };
}
// Convert the historical 10-minute-column board locally; discard names and empty cells.
export function legacyScheduleImport(text: string) {
  const rows = parseCsv(text),
    h = rows[0];
  if (h.includes("담당자 코드")) return scheduleImport(text);
  if (h[1] !== "일자" || h[3] !== "부서" || h[5] !== "치료사")
    throw new Error("시간표 CSV의 필수 열을 확인하세요.");
  const output = [
    ["일자", "부서", "담당자 코드", "시작", "종료", "예약 코드"].join(","),
  ];
  for (const r of rows.slice(1)) {
    for (let col = 7; col < r.length; col++) {
      if (!r[col]) continue;
      const start = clock(480 + (col - 7) * 10),
        end = clock(minutes(start) + 30);
      if (!validSession(start, end))
        throw new Error(
          "기존 현황판에 30분 회기 기준과 맞지 않는 예약이 있습니다. 표준 시간표 양식으로 확인해 주세요.",
        );
      output.push(
        [r[1].slice(0, 10), r[3], r[4], start, end, r[col]].join(","),
      );
    }
  }
  return scheduleImport(output.join("\n"));
}
