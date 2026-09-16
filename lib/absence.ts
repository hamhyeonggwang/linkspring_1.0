import {
  clock,
  dateSchema,
  minutes,
  slotInputSchema,
  therapyTypes,
  timeSchema,
  type SlotInput,
} from "./domain";

export type AbsenceFields = Omit<SlotInput, "type"> & {
  type: SlotInput["type"] | "";
};
const unique = (items: string[]) => [...new Set(items)];
export function ruleParse(text: string, referenceDate: string): AbsenceFields {
  const fields: AbsenceFields = {
    date: "",
    startTime: "",
    endTime: "",
    type: "",
    therapist: "",
  };
  const dates = [...text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map((m) => m[0]);
  for (const [word, offset] of [
    ["오늘", 0],
    ["내일", 1],
    ["모레", 2],
  ] as const)
    if (text.includes(word) && dateSchema.safeParse(referenceDate).success) {
      const d = new Date(`${referenceDate}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + offset);
      dates.push(d.toISOString().slice(0, 10));
    }
  const days = unique(dates);
  if (days.length === 1 && dateSchema.safeParse(days[0]).success)
    fields.date = days[0];
  const times = [...text.matchAll(/\b\d{1,2}:\d{2}\b/g)].map((m) =>
    m[0].padStart(5, "0"),
  );
  for (const m of text.matchAll(
    /(오전|오후)?\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?/g,
  )) {
    let hour = Number(m[2]);
    if (m[1] === "오후" && hour < 12) hour += 12;
    if (m[1] === "오전" && hour === 12) hour = 0;
    if (!m[1] && hour < 8) continue;
    times.push(
      `${String(hour).padStart(2, "0")}:${String(Number(m[3] ?? 0)).padStart(2, "0")}`,
    );
  }
  const starts = unique(times);
  if (starts.length === 1 && timeSchema.safeParse(starts[0]).success) {
    fields.startTime = starts[0];
    const end = clock(minutes(starts[0]) + 30);
    if (timeSchema.safeParse(end).success) fields.endTime = end;
  }
  const types = therapyTypes.filter((t) => text.includes(t));
  if (types.length === 1) fields.type = types[0];
  const staff = unique(
    [...text.matchAll(/\b(?:OT|PT|ST|SI|ED|SW)-\d{1,3}\b/gi)].map((m) =>
      m[0].toUpperCase(),
    ),
  );
  if (staff.length === 1) fields.therapist = staff[0];
  return fields;
}

export function parseClaudePayload(payload: unknown): SlotInput | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { stop_reason?: unknown; content?: unknown };
  if (p.stop_reason !== "tool_use" || !Array.isArray(p.content)) return null;
  const blocks = p.content.filter(
    (v: unknown) =>
      v &&
      typeof v === "object" &&
      (v as { type?: unknown }).type === "tool_use",
  );
  if (blocks.length !== 1 || blocks[0].name !== "structure_absence")
    return null;
  const result = slotInputSchema.safeParse(blocks[0].input);
  return result.success ? result.data : null;
}

export async function analyzeAbsence(
  text: string,
  date: string,
  config: { apiKey?: string; model?: string },
  fetcher: typeof fetch = fetch,
) {
  const fallback = (reason: string) => ({
    fields: ruleParse(text, date),
    source: "rules",
    reason,
  });
  if (!config.apiKey || !config.model) return fallback("Claude 설정 미완료");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetcher("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 400,
        system:
          "Extract only the supplied schedule tokens. Do not infer missing dates, times, services or staff. Use null for missing fields. Dates use Asia/Seoul. Sessions are 30 minutes. No diagnosis, assignment or messages. Call structure_absence only.",
        tools: [
          {
            name: "structure_absence",
            description:
              "Return schedule fields for coordinator review. Does not register or assign anything.",
            input_schema: {
              type: "object",
              properties: {
                date: { type: ["string", "null"] },
                startTime: { type: ["string", "null"] },
                endTime: { type: ["string", "null"] },
                type: {
                  type: ["string", "null"],
                  enum: [...therapyTypes, null],
                },
                therapist: { type: ["string", "null"] },
              },
              required: ["date", "startTime", "endTime", "type", "therapist"],
              additionalProperties: false,
            },
          },
        ],
        tool_choice: { type: "tool", name: "structure_absence" },
        messages: [
          { role: "user", content: `기준일: ${date}\n일정 토큰: ${text}` },
        ],
      }),
    });
    if (!response.ok) return fallback("Claude 호출 실패");
    const fields = parseClaudePayload(await response.json());
    if (
      !fields ||
      !text.includes(fields.type) ||
      !text.toUpperCase().includes(fields.therapist)
    )
      return fallback("Claude 응답 누락 또는 형식 오류");
    return { fields, source: "claude", reason: "담당자 확인 필요" };
  } catch {
    return fallback(
      controller.signal.aborted
        ? "Claude 응답 시간 초과"
        : "Claude 연결 또는 응답 오류",
    );
  } finally {
    clearTimeout(timeout);
  }
}
