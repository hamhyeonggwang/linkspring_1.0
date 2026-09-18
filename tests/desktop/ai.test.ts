import { test } from "node:test";
import assert from "node:assert/strict";
import { apiEndpoint, requestAI, type AIProvider } from "../../lib/ai-provider";
import { analyzeSchedule, assistCandidates, assistNotice, assistantInput } from "../../lib/ai-assistant";
import { emptyState, type State } from "../../lib/domain";

function fixture(): State {
  return { ...structuredClone(emptyState), participants: [1, 2].map(i => ({ id: `대기자-SECRET${i}`, externalCode: `기관표시${i}`, type: "작업치료", availability: "평일 09:00–12:00", since: `2025-01-0${i}`, recent: "없음", active: true })), slots: [{ id: "slot", date: "2030-01-07", startTime: "09:00", endTime: "09:30", type: "작업치료", therapist: "OT-01", status: "처리 대기", assignedParticipant: null, noticeStatus: "미안내", noticeText: "2030-01-07 09:00–09:30 작업치료 안내", assignedAt: null, noticeCompletedAt: null, revision: 1 }] };
}
const config = { provider: "anthropic" as const, model: "test-model", apiKey: "test-key" };
function mock(value: unknown, name: string, provider: AIProvider = "anthropic", inspect?: (body: string, init: RequestInit) => void): typeof fetch {
  return (async (_url, init) => {
    inspect?.(String(init?.body), init!);
    return new Response(JSON.stringify(provider === "anthropic" ? { stop_reason: "tool_use", content: [{ type: "tool_use", name, input: value }], usage: { input_tokens: 10, output_tokens: 20 } } : { choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ function: { name, arguments: JSON.stringify(value) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 20 } }));
  }) as typeof fetch;
}
for (const provider of ["anthropic", "openai", "gemini", "compatible"] as const) test(`${provider}: structured response and correct credential transport`, async () => {
  const r = await requestAI({ ...config, provider, endpoint: "https://example.org/v1/chat/completions" }, "check", "test", {}, {}, mock({ ok: true }, "check", provider, (_body, init) => {
    assert.equal(init.redirect, "error");
    assert.equal(new Headers(init.headers).get(provider === "anthropic" ? "x-api-key" : "authorization"), provider === "anthropic" ? "test-key" : "Bearer test-key");
  }));
  assert.deepEqual(r.value, { ok: true }); assert.equal(r.usage.inputTokens, 10);
});
test("candidate requests strip institution identities, preserve fixed ranking, and never mutate state", async () => {
  const state = fixture(), before = structuredClone(state);
  const value = { summary: "대기 기간을 비교했습니다.", recommended: "C1", comparisons: [{ ref: "C1", explanation: "가장 오래 기다린 후보입니다." }, { ref: "C2", explanation: "다음 순위입니다." }], checks: ["참석 가능 여부를 확인하세요."] };
  const r = await assistCandidates(state, "slot", config, mock(value, "explain_candidates", "anthropic", body => {
    assert(!body.includes("SECRET")); assert(!body.includes("기관표시")); assert(!body.includes("OT-01")); assert(!body.includes("2030-01-07"));
  }));
  assert.equal(r.source, "ai"); assert.equal(r.comparisons[0].participantId, state.participants[0].id); assert.deepEqual(state, before);
  assert.equal(assistantInput(state, "slot").data.candidates[0].ref, "C1");
});
test("unknown candidate or changed recommendation falls back to local facts", async () => {
  for (const recommended of ["C2", "C9"]) {
    const r = await assistCandidates(fixture(), "slot", config, mock({ summary: "bad", recommended, comparisons: [{ ref: "C9", explanation: "bad" }], checks: ["bad"] }, "explain_candidates"));
    assert.equal(r.source, "rules"); assert.equal(r.comparisons[0].ref, "C1");
  }
});
test("no key or no eligible candidates never invokes API", async () => {
  const fail = (async () => { throw new Error("must not call"); }) as typeof fetch;
  assert.equal((await assistCandidates(fixture(), "slot", {}, fail)).source, "rules");
  const state = fixture(); state.participants = [];
  assert.equal((await assistCandidates(state, "slot", config, fail)).comparisons.length, 0);
});
test("API authentication/rate limit failures expose no secret response body", async () => {
  for (const status of [401, 429, 500]) {
    const r = await assistCandidates(fixture(), "slot", config, (async () => new Response("SECRET_SERVER_RESPONSE", { status })) as typeof fetch);
    assert.equal(r.source, "rules"); assert(!r.reason.includes("SECRET"));
  }
});
test("AI notice uses authoritative schedule and rejects invented contacts", async () => {
  const state = fixture(); state.slots[0].status = "연결 완료";
  const good = await assistNotice(state, "slot", config, mock({ opening: "안녕하세요. 기다리시던 이용 기회를 안내드립니다.", closing: "참석 가능 여부를 기존 연락 채널로 알려주세요." }, "compose_notice", "anthropic", body => {
    assert(!body.includes("2030-01-07")); assert(!body.includes("기관표시"));
  }));
  assert.equal(good.source, "ai"); assert(good.draft?.includes("2030-01-07 09:00–09:30"));
  const bad = await assistNotice(state, "slot", config, mock({ opening: "010-1234-5678로 연락하세요", closing: "감사합니다" }, "compose_notice"));
  assert.equal(bad.source, "rules"); assert.equal(bad.draft, state.slots[0].noticeText);
});
test("AI absence supports relative weekday but cannot overwrite explicit time or staff", async () => {
  const fields = { date: "2030-01-08", startTime: "09:00", endTime: "09:30", type: "작업치료", therapist: "OT-01" };
  assert.equal((await analyzeSchedule("다음 주 화요일 오전 9시 작업치료 OT-01", "2030-01-04", config, mock(fields, "structure_absence"))).source, "ai");
  assert.equal((await analyzeSchedule("2030-01-08 오전 10시 작업치료 OT-01", "2030-01-04", config, mock(fields, "structure_absence"))).source, "rules");
});
test("custom endpoint rejects plaintext, embedded credentials and query secrets", () => {
  for (const endpoint of ["http://example.com", "https://user:password@example.com/v1", "https://example.com/?key=secret"]) assert.throws(() => apiEndpoint({ provider: "compatible", endpoint }));
});
