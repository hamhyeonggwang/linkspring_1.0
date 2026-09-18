import { z } from "zod";
import { candidatesFor, scheduleTokens, slotInputSchema, therapyTypes, type State } from "./domain";
import { ruleParse } from "./absence";
import { requestAI, AIError, type AIConfig, type AIUsage } from "./ai-provider";

const objectSchema = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const textField = { type: "string" };
export type AssistResult = {
  source: "ai" | "rules"; reason: string; provider?: string; model?: string; usage?: AIUsage;
  summary: string; comparisons: { ref: string; participantId: string; explanation: string }[];
  checks: string[]; draft?: string;
};
export function assistantInput(state: State, slotId: string) {
  const slot = state.slots.find(s => s.id === slotId);
  if (!slot) throw new Error("회기를 찾을 수 없습니다.");
  const candidates = candidatesFor(slot, state, 0).slice(0, 5);
  // Only these allowlisted facts leave the PC: no IDs, labels, birthdates or notes.
  const data = {
    service: slot.type,
    candidates: candidates.map((c, i) => ({ ref: `C${i + 1}`, rank: i + 1, waitingDays: c.waiting, daysSinceLastConnection: c.recent === "없음" ? null : Math.max(0, Math.floor((Date.parse(slot.date) - Date.parse(c.recent)) / 86400000)), exactMatch: c.exact })),
  };
  return { slot, candidates, data };
}
const explanationSchema = z.object({
  summary: z.string().min(1).max(500),
  recommended: z.string().max(3),
  comparisons: z.array(z.object({ ref: z.string().max(3), explanation: z.string().min(1).max(300) }).strict()).min(1).max(5),
  checks: z.array(z.string().min(1).max(180)).min(1).max(3),
}).strict();
export async function assistCandidates(state: State, slotId: string, config: AIConfig, fetcher: typeof fetch = fetch): Promise<AssistResult> {
  const { slot, candidates, data } = assistantInput(state, slotId);
  if (slot.status === "연결 완료") throw new Error("연결된 회기는 안내문 기능을 사용하세요.");
  const fallback = (reason: string): AssistResult => ({
    source: "rules", reason,
    summary: candidates.length ? `일치 후보 중 우선순위 상위 ${candidates.length}명을 비교합니다. 대기 기간, 최근 연결, 익명 표시 순으로 확인하세요.` : "현재 30분 전체 시간이 일치하는 대기자가 없습니다. 가능 시간을 확인하거나 추가 확인으로 보류하세요.",
    comparisons: candidates.map((c, i) => ({ ref: `C${i + 1}`, participantId: c.participant.id, explanation: `시간 일치 · 대기 ${c.waiting}일 · 최근 연결 ${c.recent}` })),
    checks: ["기관의 실제 가능 일정과 보호자의 참석 가능 여부를 확인하세요.", "최종 연결과 안내는 담당자가 수행합니다."],
  });
  if (!candidates.length) return fallback("일치 후보 없음 · AI 호출 생략");
  try {
    const response = await requestAI(config, "explain_candidates",
      "Explain the supplied fixed ranking in plain Korean, comparing waiting days and recency. Recommend C1 only; do not reorder or invent candidates. Include every supplied ref exactly once. daysSinceLastConnection means days since service opportunity assignment (최근 서비스 연결), not phone contact; null means no prior recorded connection. Use everyday Korean, never internal field names such as exactMatch. No clinical advice. Give practical verification questions without inventing facts.",
      objectSchema({ summary: textField, recommended: { type: "string", enum: ["C1"] }, comparisons: { type: "array", items: objectSchema({ ref: textField, explanation: textField }) }, checks: { type: "array", items: textField } }), data, fetcher);
    const parsed = explanationSchema.parse(response.value);
    if (parsed.recommended !== "C1" || parsed.comparisons.length !== candidates.length || new Set(parsed.comparisons.map(c => c.ref)).size !== candidates.length || parsed.comparisons.some(c => !data.candidates.some(d => d.ref === c.ref))) throw new Error("Unknown candidate");
    return { source: "ai", reason: "AI 생성 설명 · 원본 조건과 비교 후 담당자 확인", ...response, ...parsed,
      comparisons: candidates.map((c, i) => ({ ref: `C${i + 1}`, participantId: c.participant.id, explanation: parsed.comparisons.find(x => x.ref === `C${i + 1}`)!.explanation })) };
  } catch (e) { return fallback(e instanceof AIError ? e.message : "AI 설명 검증 실패 · 검증된 기본 근거를 표시합니다."); }
}
export async function assistNotice(state: State, slotId: string, config: AIConfig, fetcher: typeof fetch = fetch): Promise<AssistResult> {
  const { slot } = assistantInput(state, slotId);
  if (slot.status !== "연결 완료") throw new Error("연결 확정 후 안내문을 작성하세요.");
  const base = { summary: "보호자에게 보낼 안내문입니다. 전달 전에 내용을 확인하세요.", comparisons: [], checks: ["수신 대상과 일정을 확인한 뒤 기관의 연락 채널에서 직접 전달하세요."] };
  try {
    const response = await requestAI(config, "compose_notice",
      "Write a warm, concise Korean opening and closing for a guardian appointment notice. No names, numbers, dates, times, contact details, URLs, medical advice, fees or promises. Do not say it was sent. Schedule facts are inserted by the app. Ask the guardian to confirm attendance using the institution's existing contact channel.",
      objectSchema({ opening: textField, closing: textField }), { purpose: "빈 회기 연결 후 보호자 참석 확인", tone: "정중하고 짧게" }, fetcher);
    const parts = z.object({ opening: z.string().min(1).max(200), closing: z.string().min(1).max(300) }).strict().parse(response.value);
    if (/[0-9@]|https?:|www\.|[월화수목금토일]요일/.test(parts.opening + parts.closing)) throw new Error("Invented schedule or contact");
    return { ...base, ...response, source: "ai", reason: "AI 작성 · 일정은 확정된 데이터에서 자동 삽입", draft: `${parts.opening}\n\n일정: ${slot.date} ${slot.startTime}–${slot.endTime}\n서비스: ${slot.type}\n\n${parts.closing}` };
  } catch (e) { return { ...base, source: "rules", reason: e instanceof AIError ? e.message : "AI 안내문 검증 실패 · 기본 안내문을 표시합니다.", draft: slot.noticeText }; }
}
export async function analyzeSchedule(text: string, date: string, config: AIConfig, fetcher: typeof fetch = fetch) {
  const tokens = scheduleTokens(text);
  const fallback = (reason: string) => ({ fields: ruleParse(tokens, date), source: "rules", reason });
  try {
    const response = await requestAI(config, "structure_absence",
      "Extract one 30-minute session from schedule tokens. Resolve relative weekdays using referenceDate in Asia/Seoul; next week starts Monday. Leave unknown or conflicting fields null. Do not invent a staff code. Return all five fields.",
      objectSchema(Object.fromEntries(["date", "startTime", "endTime", "type", "therapist"].map(k => [k, { type: ["string", "null"], ...(k === "type" ? { enum: [...therapyTypes, null] } : {}) }]))),
      { referenceDate: date, tokens }, fetcher);
    const fields = z.object({ date: z.string().nullable(), startTime: z.string().nullable(), endTime: z.string().nullable(), type: z.string().nullable(), therapist: z.string().nullable() }).strict().parse(response.value);
    const checked = slotInputSchema.safeParse(fields);
    if (!checked.success || !tokens.includes(checked.data.type) || !tokens.toUpperCase().includes(checked.data.therapist)) return fallback("AI 응답 누락 또는 형식 오류 · 누락 항목을 확인하세요.");
    // Explicit facts may never be replaced by model inference.
    const rules = ruleParse(tokens, date);
    if (Object.entries(rules).some(([k, v]) => v && checked.data[k as keyof typeof rules] !== v)) return fallback("AI 결과가 입력 일정과 다릅니다. 직접 확인하세요.");
    return { fields: checked.data, source: "ai", reason: "AI 분석 · 담당자 확인 필요", provider: response.provider, model: response.model, usage: response.usage };
  } catch (e) { return fallback(e instanceof AIError ? e.message : "AI 응답 검증 실패"); }
}
export async function testAIConnection(config: AIConfig) {
  const result = await requestAI(config, "connection_check", "Return status ok for this synthetic connection check.", objectSchema({ status: { type: "string", enum: ["ok"] } }), { test: "synthetic, no work data" });
  z.object({ status: z.literal("ok") }).parse(result.value);
  return { provider: result.provider, model: result.model, usage: result.usage };
}
