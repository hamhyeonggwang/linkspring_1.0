"use client";
import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { participantLabel, type Slot, type State } from "../lib/domain";
import { providerNames, type AIProvider } from "../lib/ai-provider";
import type { AssistResult } from "../lib/ai-assistant";

export function AIAssistPanel({ slot, state, disabled, onSave }: { slot: Slot; state: State; disabled: boolean; onSave: (payload: Record<string, unknown>) => Promise<boolean> }) {
  const [result, setResult] = useState<AssistResult>();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const notice = slot.status === "연결 완료";
  const run = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      if (!window.linkspring) throw new Error("AI 업무 도우미는 Windows 설치형에서 이용하세요.");
      const r = await window.linkspring.call("aiAssist", { kind: notice ? "notice" : "candidates", slotId: slot.id, version: state.settings.state_revision }) as AssistResult;
      setResult(r); setDraft(r.draft ?? "");
    } catch (e) { setError(e instanceof Error ? e.message : "AI 요청 실패"); }
    finally { setBusy(false); }
  };
  return <section className="ai-assist" aria-label={notice ? "AI 안내문 도우미" : "AI 후보 비교 도우미"}>
    <div className="ai-assist-heading"><strong><Sparkles size={18} />{notice ? "AI 안내문 초안" : "AI 연결 후보 비교"}</strong><span>담당자 검토 필수</span></div>
    <p>{notice ? "AI가 보호자에게 전할 문장을 작성하고, 확정된 일정은 프로그램이 정확히 삽입합니다." : "시간이 일치하는 상위 5명의 대기 기간과 최근 연결을 AI가 비교해 추천 근거와 확인할 사항을 설명합니다."}</p>
    <details><summary>AI에 전송하는 정보</summary><p>{notice ? "개인정보와 실제 일정은 보내지 않습니다. 안내 목적과 문체만 전달합니다." : "서비스 종류, 요청마다 만든 C1~C5 번호, 대기 일수, 최근 연결 이후 일수, 시간 일치 여부만 보냅니다. 이름·기관 코드·연락처·생년월일·CSV 원문은 보내지 않습니다."} 설정한 제공사로 전송되며 API 요금이 발생할 수 있습니다.</p></details>
    <Button onClick={() => void run()} disabled={disabled || busy || (notice && slot.noticeStatus === "안내 완료")}><Sparkles size={16} />{busy ? "AI가 분석 중입니다…" : notice ? "AI 안내문 작성" : "AI 후보 비교 실행"}</Button>
    {error && <p role="alert">{error}</p>}
    {result && <div className="ai-result" aria-live="polite">
      <div className={`ai-source ${result.source}`}><b>{result.source === "ai" ? `AI 생성 · ${providerNames[result.provider as AIProvider] ?? result.provider} · ${result.model}` : "기본 결과 · AI 미사용"}</b><small>{result.reason}</small>{result.usage && <small>이번 요청 토큰: 입력 {result.usage.inputTokens} / 출력 {result.usage.outputTokens}</small>}</div>
      <p>{result.summary}</p>
      {result.comparisons.length > 0 && <div className="ai-comparisons">{result.comparisons.map(c => <div className="ai-comparison" key={c.ref}><b>{c.ref} · {participantLabel(state.participants.find(p => p.id === c.participantId)!)}</b><p>{c.explanation}</p></div>)}</div>}
      <ul>{result.checks.map(c => <li key={c}>{c}</li>)}</ul>
      {notice && <><label>검토·수정할 안내문<Textarea aria-label="AI 안내문 검토" maxLength={1600} rows={7} value={draft} onChange={e => setDraft(e.target.value)} /></label><Button disabled={disabled || busy || !draft.trim()} onClick={() => void onSave({ kind: "notice_draft", slotId: slot.id, text: draft, source: result.source })}>검토한 안내문 저장</Button><p>저장한 안내문은 아래에서 복사할 수 있습니다. 자동 발송하지 않습니다.</p></>}
    </div>}
  </section>;
}
