"use client";
import { useEffect, useState, useRef, useCallback } from "react";
import {
  Link2,
  Users,
  CalendarDays,
  ListTodo,
  CircleAlert,
  Send,
  Settings2,
  RefreshCw,
  ClipboardPaste,
} from "lucide-react";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  emptyState,
  candidatesFor,
  availabilityLabel,
  participantSchema,
  slotInputSchema,
  therapyTypes,
  today,
  clock,
  minutes,
  scheduleTokens,
  noticeTemplates,
  type State,
  type SlotInput,
  type Participant,
} from "@/lib/domain";
import type { AbsenceFields } from "@/lib/absence";
import { decodeCsv, participantImport, legacyScheduleImport } from "@/lib/csv";

const nav = [
  { id: "queue", label: "처리 대기", icon: ListTodo },
  { id: "children", label: "대기자 관리", icon: Users },
  { id: "schedule", label: "서비스 일정", icon: CalendarDays },
  { id: "review", label: "추가 확인 필요", icon: CircleAlert },
  { id: "history", label: "연결·안내 내역", icon: Send },
];
type Preview =
  | ReturnType<typeof participantImport>
  | ReturnType<typeof legacyScheduleImport>;
const blankSlot = (): AbsenceFields => ({
  date: today(),
  startTime: "",
  endTime: "",
  type: "",
  therapist: "",
});
const blankPerson = (): Participant => ({
  id: `대기자-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
  type: "작업치료",
  availability: "평일 09:00–12:00",
  since: today(),
  recent: "없음",
  active: true,
});
export default function Home() {
  const [state, setState] = useState<State>(emptyState),
    [view, setView] = useState("queue"),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [authRequired, setAuthRequired] = useState(false),
    [busy, setBusy] = useState(false);
  const busyRef = useRef(false),
    [activeId, setActiveId] = useState<string | null>(null),
    [selected, setSelected] = useState(""),
    [tolerance, setTolerance] = useState("0"),
    [query, setQuery] = useState(""),
    [date, setDate] = useState("");
  const [absenceOpen, setAbsenceOpen] = useState(false),
    [message, setMessage] = useState(""),
    [safeText, setSafeText] = useState(""),
    [parsedSlot, setParsedSlot] = useState<AbsenceFields>(blankSlot),
    [source, setSource] = useState("직접 입력"),
    [parsing, setParsing] = useState(false);
  const [person, setPerson] = useState<Participant | null>(null),
    [editing, setEditing] = useState(false),
    [preview, setPreview] = useState<Preview | null>(null),
    [templateOpen, setTemplateOpen] = useState(false),
    [template, setTemplate] = useState("");
  const participantFile = useRef<HTMLInputElement>(null),
    scheduleFile = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const r = await fetch("/api/state", { cache: "no-store" });
      const data = (await r.json()) as State & { error?: string };
      if (!r.ok) {
        setAuthRequired(r.status === 401);
        throw new Error(data.error ?? "목록을 불러오지 못했습니다.");
      }
      setState(data);
      setAuthRequired(false);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "목록을 불러오지 못했습니다.");
      return false;
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    // The initial request is an external subscription; loading is already true.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  const mutate = async (payload: Record<string, unknown>) => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    try {
      const r = await fetch("/api/state", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...payload,
          version: state.settings.state_revision,
        }),
      });
      const data = (await r.json()) as { error?: string };
      if (!r.ok) throw new Error(data.error ?? "저장에 실패했습니다.");
      const refreshed = await load();
      if (refreshed) toast.success("저장되었습니다.");
      else
        toast(
          "저장은 완료됐지만 목록을 불러오지 못했습니다. 새로고침해 주세요.",
        );
      return true;
    } catch (e) {
      toast.error(
        e instanceof Error
          ? e.message
          : "저장 여부를 확인하지 못했습니다. 새로고침해 주세요.",
      );
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const active = state.slots.find((s) => s.id === activeId),
    candidates = active ? candidatesFor(active, state, Number(tolerance)) : [];
  const openSlot = (id: string) => {
    setActiveId(id);
    setSelected("");
    setTolerance("0");
  };
  const visibleSlots = state.slots
    .filter(
      (s) =>
        (!date || s.date === date) &&
        (!query ||
          `${s.type} ${s.therapist} ${s.assignedParticipant ?? ""}`.includes(
            query,
          )),
    )
    .filter((s) =>
      view === "history"
        ? s.status === "연결 완료"
        : view === "review"
          ? s.status === "추가 확인 필요"
          : s.status !== "연결 완료",
    );
  const importFile = async (
    file: File | undefined,
    kind: "participants" | "schedule",
  ) => {
    if (!file) return;
    try {
      const text = await decodeCsv(file);
      setPreview(
        kind === "participants"
          ? participantImport(text)
          : legacyScheduleImport(text),
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "CSV를 읽지 못했습니다.");
    }
  };
  const parse = async () => {
    if (!safeText.trim()) {
      toast.error("먼저 일정 정보만 추출해 주세요.");
      return;
    }
    setParsing(true);
    try {
      const r = await fetch("/api/ai/parse-absence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: safeText }),
      });
      const data = (await r.json()) as {
        error?: string;
        fields: AbsenceFields;
        source: string;
        reason: string;
      };
      if (!r.ok)
        throw new Error(
          data.error ?? "분석하지 못했습니다. 직접 입력해 주세요.",
        );
      setParsedSlot(data.fields);
      setSource(
        data.source === "claude"
          ? "Claude 분석 · 담당자 확인 필요"
          : `규칙 분석 · ${data.reason} · 누락 항목 직접 입력 필요`,
      );
      toast("결과를 시간표와 비교하고 수정한 뒤 등록해 주세요.");
    } catch (e) {
      setSource("분석 실패 · 직접 입력");
      toast.error(e instanceof Error ? e.message : "분석에 실패했습니다.");
    } finally {
      setParsing(false);
    }
  };
  const register = async () => {
    const checked = slotInputSchema.safeParse(parsedSlot);
    if (!checked.success) {
      toast.error(
        "날짜, 담당자 코드와 운영 시간 내 30분 회기를 확인해 주세요.",
      );
      return;
    }
    if (await mutate({ kind: "create", slot: checked.data })) {
      setAbsenceOpen(false);
      setMessage("");
      setSafeText("");
      setView("queue");
    }
  };
  return (
    <div className="app-shell">
      <Toaster position="top-center" richColors />
      <header className="global-header">
        <div className="brand">
          <span className="brand-mark">
            <Link2 />
          </span>
          <div>
            <strong>이어:봄</strong>
            <small>LinkSpring</small>
          </div>
        </div>
        <div className="global-context">
          <strong>기다리던 기회를 잇는 일정 관리</strong>
          <span>{today()}</span>
        </div>
        <div className="top-actions">
          <Button
            variant="outline"
            onClick={() => void load()}
            disabled={loading || busy}
          >
            <RefreshCw size={16} />
            새로고침
          </Button>
          <Button
            disabled={!!error || loading || busy}
            onClick={() => {
              setParsedSlot(blankSlot());
              setSource("직접 입력");
              setAbsenceOpen(true);
            }}
          >
            <ClipboardPaste size={16} />
            결석·빈 회기 등록
          </Button>
        </div>
      </header>
      <aside className="sidebar">
        <nav aria-label="주요 메뉴">
          {nav.map((n) => (
            <button
              key={n.id}
              title={n.label}
              className={view === n.id ? "nav-active" : ""}
              onClick={() => setView(n.id)}
            >
              <n.icon size={18} />
              <span>{n.label}</span>
            </button>
          ))}
        </nav>
        <div className="side-bottom">
          <button
            disabled={!!error || loading}
            onClick={() => {
              setTemplate(
                noticeTemplates.find(
                  (t) => t === state.settings.notice_template,
                ) ?? noticeTemplates[0],
              );
              setTemplateOpen(true);
            }}
          >
            <Settings2 size={18} />
            안내문 기본문구
          </button>
          <p className="privacy-note">
            가명 ID로 관리합니다.
            <br />
            최종 연결과 안내는 담당자가 확인합니다.
          </p>
        </div>
      </aside>
      <main className="main">
        <div className="content-frame">
          <header className="page-header">
            <h1>{nav.find((n) => n.id === view)?.label}</h1>
            <span>{busy ? "저장 중…" : "코디네이터 업무"}</span>
          </header>
          {loading && <p role="status">일정을 불러오는 중입니다…</p>}
          {error && (
            <div role="alert" className="import-warnings">
              <p>{error}</p>
              {authRequired ? (
                <a href="/signin-with-chatgpt?return_to=%2F" target="_top">
                  코디네이터 로그인
                </a>
              ) : (
                <Button onClick={() => void load()}>다시 불러오기</Button>
              )}
            </div>
          )}
          {!loading && !error && (
            <>
              {["queue", "review", "history"].includes(view) && (
                <section>
                  <div className="filter-row">
                    <label>
                      날짜
                      <Input
                        type="date"
                        value={date}
                        onChange={(e) => setDate(e.target.value)}
                      />
                    </label>
                    <label>
                      서비스·담당자·대기자
                      <Input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="코드 또는 서비스 검색"
                      />
                    </label>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setDate("");
                        setQuery("");
                      }}
                    >
                      전체 보기
                    </Button>
                  </div>
                  <p className="section-head">
                    {visibleSlots.length}건 · 날짜와 시간순
                  </p>
                  <div className="queue-list">
                    {visibleSlots.length ? (
                      visibleSlots.map((s, i) => (
                        <button
                          className="queue-card"
                          key={s.id}
                          onClick={() => openSlot(s.id)}
                        >
                          <span>{i + 1}</span>
                          <div className="queue-date">
                            <strong>{s.date}</strong>
                            <span>
                              {s.startTime}–{s.endTime}
                            </span>
                          </div>
                          <span>
                            {s.type}
                            <br />
                            {s.therapist}
                          </span>
                          <span>
                            {s.status === "연결 완료"
                              ? s.assignedParticipant
                              : `일치 후보 ${candidatesFor(s, state).length}명`}
                          </span>
                          <Badge variant="outline">
                            {s.status === "연결 완료"
                              ? s.noticeStatus
                              : s.status}
                          </Badge>
                        </button>
                      ))
                    ) : (
                      <p className="empty-history">
                        해당하는 회기가 없습니다. 시간표를 가져온 뒤 결석 회기를
                        등록해 주세요.
                      </p>
                    )}
                  </div>
                </section>
              )}
              {view === "children" && (
                <section>
                  <div className="section-head">
                    <p>가명 ID·서비스·가능 시간과 희망 일정을 관리합니다.</p>
                    <div className="inline-actions">
                      <Button
                        variant="outline"
                        onClick={() => participantFile.current?.click()}
                      >
                        CSV 불러오기
                      </Button>
                      <Button
                        onClick={() => {
                          setEditing(false);
                          setPerson(blankPerson());
                        }}
                      >
                        대기자 등록
                      </Button>
                    </div>
                  </div>
                  <input
                    hidden
                    ref={participantFile}
                    type="file"
                    accept=".csv"
                    onChange={(e) => {
                      void importFile(e.target.files?.[0], "participants");
                      e.target.value = "";
                    }}
                  />
                  <p>
                    <a href="/examples/participants.csv" download>
                      대기 명단 CSV 양식
                    </a>{" "}
                    · 실명·생년월일 대신 기관에서 발급한 가명 ID를 사용하세요.
                  </p>
                  <div className="table-card">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          {[
                            "가명 ID",
                            "서비스",
                            "가능 시간",
                            "대기 시작",
                            "상태",
                            "",
                          ].map((h, i) => (
                            <TableHead key={i}>{h}</TableHead>
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {state.participants.map((p) => (
                          <TableRow key={p.id}>
                            <TableCell>{p.id}</TableCell>
                            <TableCell>{p.type}</TableCell>
                            <TableCell>
                              {availabilityLabel(p.availability)}
                              {state.participantRequests.some(
                                (r) => r.participantId === p.id,
                              ) && <p>희망 날짜별 신청을 우선 적용</p>}
                            </TableCell>
                            <TableCell>{p.since}</TableCell>
                            <TableCell>
                              {p.active ? "활성" : "일시 중지"}
                            </TableCell>
                            <TableCell>
                              <Button
                                variant="ghost"
                                onClick={() => {
                                  setEditing(true);
                                  setPerson({
                                    ...p,
                                    availability: availabilityLabel(
                                      p.availability,
                                    ),
                                  });
                                }}
                              >
                                수정
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  {!state.participants.length && (
                    <p className="empty-history">등록된 대기자가 없습니다.</p>
                  )}
                  <h2 className="section-head">날짜별 희망 일정</h2>
                  <div className="table-card">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          {[
                            "대기자",
                            "날짜",
                            "서비스",
                            "오전 / 오후",
                            "상태",
                          ].map((h) => (
                            <TableHead key={h}>{h}</TableHead>
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {state.participantRequests.map((r) => (
                          <TableRow key={r.id}>
                            <TableCell>{r.participantId}</TableCell>
                            <TableCell>{r.desiredDate}</TableCell>
                            <TableCell>{r.therapyTypes}</TableCell>
                            <TableCell>
                              {r.morningTimes} / {r.afternoonTimes}
                            </TableCell>
                            <TableCell>{r.status}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </section>
              )}
              {view === "schedule" && (
                <section>
                  <div className="section-head">
                    <p>
                      시간표의 예약 회기를 확인한 뒤 결석한 회기만 등록합니다.
                    </p>
                    <Button onClick={() => scheduleFile.current?.click()}>
                      시간표 CSV 불러오기
                    </Button>
                  </div>
                  <input
                    hidden
                    ref={scheduleFile}
                    type="file"
                    accept=".csv"
                    onChange={(e) => {
                      void importFile(e.target.files?.[0], "schedule");
                      e.target.value = "";
                    }}
                  />
                  <p>
                    <a href="/examples/schedule.csv" download>
                      시간표 CSV 양식
                    </a>{" "}
                    · 08:30–12:00 / 13:00–18:00, 30분 회기
                  </p>
                  <label>
                    날짜
                    <Input
                      type="date"
                      value={date}
                      onChange={(e) => setDate(e.target.value)}
                    />
                  </label>
                  <div className="table-card">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          {[
                            "날짜",
                            "시간",
                            "서비스",
                            "담당자 코드",
                            "회기 상태",
                          ].map((h) => (
                            <TableHead key={h}>{h}</TableHead>
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {state.scheduleEntries
                          .filter((e) => !date || e.date === date)
                          .map((e) => {
                            const s = state.slots.find(
                              (s) =>
                                s.date === e.date &&
                                s.therapist === e.therapistId &&
                                s.startTime === e.startTime,
                            );
                            return (
                              <TableRow key={e.id}>
                                <TableCell>{e.date}</TableCell>
                                <TableCell>
                                  {e.startTime}–{e.endTime}
                                </TableCell>
                                <TableCell>{e.department}</TableCell>
                                <TableCell>{e.therapistId}</TableCell>
                                <TableCell>
                                  {s ? (
                                    <Button
                                      variant="outline"
                                      onClick={() => openSlot(s.id)}
                                    >
                                      {s.status}
                                    </Button>
                                  ) : (
                                    <Button
                                      variant="outline"
                                      onClick={() => {
                                        setParsedSlot({
                                          date: e.date,
                                          startTime: e.startTime,
                                          endTime: e.endTime,
                                          type: e.department,
                                          therapist: e.therapistId,
                                        });
                                        setSource(
                                          "시간표에서 선택 · 결석 여부 확인 필요",
                                        );
                                        setAbsenceOpen(true);
                                      }}
                                    >
                                      결석 등록
                                    </Button>
                                  )}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                      </TableBody>
                    </Table>
                  </div>
                  {!state.scheduleEntries.length && (
                    <p className="empty-history">등록된 시간표가 없습니다.</p>
                  )}
                </section>
              )}
              {view === "history" && (
                <section>
                  <h2 className="section-head">최근 처리 이력</h2>
                  <div className="table-card">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>시각</TableHead>
                          <TableHead>처리</TableHead>
                          <TableHead>담당자</TableHead>
                          <TableHead>내용</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {state.audit.map((a) => (
                          <TableRow key={a.id}>
                            <TableCell>{a.createdAt} UTC</TableCell>
                            <TableCell>{a.action}</TableCell>
                            <TableCell>{a.actor}</TableCell>
                            <TableCell>{a.detail}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </main>
      <Dialog
        open={!!active}
        onOpenChange={(o) => {
          if (!o && !busy) setActiveId(null);
        }}
      >
        <DialogContent className="candidate-dialog">
          <DialogHeader>
            <DialogTitle>
              {active?.status === "연결 완료"
                ? "연결 및 안내 결과"
                : "연결 후보 확인"}
            </DialogTitle>
            <DialogDescription>
              {active?.date} {active?.startTime}–{active?.endTime} ·{" "}
              {active?.type} · {active?.therapist}
            </DialogDescription>
          </DialogHeader>
          {active &&
            (active.status === "연결 완료" ? (
              <>
                <p>
                  {active.assignedParticipant} · {active.noticeStatus}
                </p>
                <Textarea
                  readOnly
                  aria-label="보호자 안내문"
                  value={active.noticeText}
                />
                <Button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(active.noticeText);
                      toast.success("안내문을 복사했습니다.");
                    } catch {
                      toast.error(
                        "복사 권한을 확인하거나 안내문을 직접 선택해 주세요.",
                      );
                    }
                  }}
                >
                  안내문 복사
                </Button>
                <p>기관 연락 채널에서 직접 전달한 뒤 완료로 기록하세요.</p>
                <Button
                  disabled={busy || active.noticeStatus === "안내 완료"}
                  onClick={() =>
                    void mutate({ kind: "notice", slotId: active.id })
                  }
                >
                  실제 안내 완료로 기록
                </Button>
              </>
            ) : (
              <>
                <Select
                  value={tolerance}
                  onValueChange={(v) => {
                    setTolerance(v);
                    setSelected("");
                  }}
                >
                  <SelectTrigger aria-label="시간 범위">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">정확히 일치</SelectItem>
                    <SelectItem value="30">±30분 인접 후보 포함</SelectItem>
                    <SelectItem value="60">±1시간 인접 후보 포함</SelectItem>
                  </SelectContent>
                </Select>
                <p className="rule-note">
                  활성 대기자 · 날짜·서비스·전체 회기 시간 일치. 대기 기간이 긴
                  순, 동률이면 최근 연결이 오래된 순과 가명 ID 순입니다.
                </p>
                <div className="candidate-list">
                  {candidates.map((c, i) => (
                    <button
                      className={`candidate ${selected === c.participant.id ? "selected" : ""}`}
                      key={c.participant.id}
                      disabled={!c.exact || busy}
                      onClick={() => setSelected(c.participant.id)}
                    >
                      <span className="rank">{i + 1}</span>
                      <div>
                        <strong>{c.participant.id}</strong>
                        <small>{c.reason}</small>
                      </div>
                      <div>
                        대기 {c.waiting}일<br />
                        최근 연결 {c.recent}
                      </div>
                      <span>
                        {c.exact
                          ? "현재 회기 가능"
                          : `가능 시작: ${c.alternativeStarts.join(", ")}`}
                      </span>
                    </button>
                  ))}
                  {!candidates.length && (
                    <p className="candidate-empty">
                      조건에 맞는 후보가 없습니다. 추가 확인으로 보류하세요.
                    </p>
                  )}
                </div>
                <div className="dialog-footer">
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={async () => {
                      if (await mutate({ kind: "hold", slotId: active.id }))
                        setActiveId(null);
                    }}
                  >
                    추가 확인 필요
                  </Button>
                  <Button
                    disabled={!selected || busy || !!error}
                    onClick={async () => {
                      if (
                        !window.confirm(
                          `${active.date} ${active.startTime} ${selected} 연결을 최종 확정할까요?`,
                        )
                      )
                        return;
                      await mutate({
                        kind: "confirm",
                        slotId: active.id,
                        participantId: selected,
                      });
                    }}
                  >
                    담당자 확인 후 연결 확정
                  </Button>
                </div>
              </>
            ))}
        </DialogContent>
      </Dialog>
      <Dialog
        open={absenceOpen}
        onOpenChange={(o) => {
          if (!busy && !parsing) {
            setAbsenceOpen(o);
            if (!o) {
              setMessage("");
              setSafeText("");
            }
          }
        }}
      >
        <DialogContent className="absence-dialog">
          <DialogHeader>
            <DialogTitle>결석·빈 회기 등록</DialogTitle>
            <DialogDescription>
              원문은 이 브라우저에서만 처리합니다. Claude에는 아래 확인한 일정
              정보만 전송합니다.
            </DialogDescription>
          </DialogHeader>
          <div className="parse-grid">
            <div>
              <label>
                결석 문자 (선택)
                <Textarea
                  maxLength={4000}
                  value={message}
                  onChange={(e) => {
                    setMessage(e.target.value);
                    setSafeText("");
                  }}
                  placeholder="문장을 붙여넣거나 오른쪽에 직접 입력하세요."
                />
              </label>
              <Button
                variant="outline"
                disabled={!message.trim()}
                onClick={() => setSafeText(scheduleTokens(message))}
              >
                일정 정보만 추출
              </Button>
              <label>
                Claude로 전송할 일정 정보
                <Textarea readOnly value={safeText} />
              </label>
              <Button
                disabled={!safeText || parsing || busy}
                onClick={() => void parse()}
              >
                {parsing ? "분석 중…" : "내용 확인 후 Claude로 분석"}
              </Button>
              <p>
                전송할 항목에 개인을 식별하는 정보가 없는지 확인하세요.
                생년월일과 혼동할 수 있는 지난 날짜·월일 표기는 제외하며, 누락된
                날짜는 직접 입력하세요.
              </p>
            </div>
            <div>
              <Badge variant="outline">{source}</Badge>
              <Field
                label="날짜"
                type="date"
                value={parsedSlot.date}
                onChange={(date) => setParsedSlot((p) => ({ ...p, date }))}
              />
              <Field
                label="시작"
                type="time"
                value={parsedSlot.startTime}
                onChange={(startTime) =>
                  setParsedSlot((p) => ({
                    ...p,
                    startTime,
                    endTime: clock(minutes(startTime) + 30),
                  }))
                }
              />
              <Field
                label="종료"
                type="time"
                value={parsedSlot.endTime}
                onChange={(endTime) =>
                  setParsedSlot((p) => ({ ...p, endTime }))
                }
              />
              <label>
                서비스
                <Select
                  value={parsedSlot.type}
                  onValueChange={(type) =>
                    setParsedSlot((p) => ({
                      ...p,
                      type: type as SlotInput["type"],
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="서비스 확인 필요" />
                  </SelectTrigger>
                  <SelectContent>
                    {therapyTypes.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <Field
                label="담당자 코드"
                value={parsedSlot.therapist}
                onChange={(therapist) =>
                  setParsedSlot((p) => ({ ...p, therapist }))
                }
              />
              <Button
                disabled={busy || parsing || !!error}
                onClick={() => void register()}
              >
                결석 여부·수정 내용 확인 후 등록
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!person}
        onOpenChange={(o) => {
          if (!o && !busy) setPerson(null);
        }}
      >
        <DialogContent className="participant-dialog">
          <DialogHeader>
            <DialogTitle>{editing ? "대기자 수정" : "대기자 등록"}</DialogTitle>
            <DialogDescription>
              실명 대신 기관에서 관리하는 가명 ID를 사용합니다.
            </DialogDescription>
          </DialogHeader>
          {person && (
            <div className="participant-form">
              <Field
                label="가명 ID"
                disabled={editing}
                value={person.id}
                onChange={(id) => setPerson({ ...person, id })}
              />
              <Field
                label="서비스 (복수는 쉼표와 공백)"
                value={person.type}
                onChange={(type) => setPerson({ ...person, type })}
              />
              <Field
                label="가능 요일·시간 (예: 월·수 09:00–12:00)"
                value={person.availability}
                onChange={(availability) =>
                  setPerson({ ...person, availability })
                }
              />
              <Field
                label="대기 시작일"
                type="date"
                value={person.since}
                onChange={(since) => setPerson({ ...person, since })}
              />
              <Select
                value={person.active ? "active" : "inactive"}
                onValueChange={(v) =>
                  setPerson({ ...person, active: v === "active" })
                }
              >
                <SelectTrigger aria-label="대기 상태">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">활성</SelectItem>
                  <SelectItem value="inactive">일시 중지</SelectItem>
                </SelectContent>
              </Select>
              <Button
                disabled={busy}
                onClick={async () => {
                  const p = participantSchema.safeParse(person);
                  if (!p.success) {
                    toast.error(
                      "가명 ID·서비스·날짜·가능 시간 형식을 확인해 주세요.",
                    );
                    return;
                  }
                  if (
                    !editing &&
                    state.participants.some((v) => v.id === p.data.id)
                  ) {
                    toast.error("이미 등록된 가명 ID입니다.");
                    return;
                  }
                  if (
                    await mutate({ kind: "participant", participant: p.data })
                  )
                    setPerson(null);
                }}
              >
                저장
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!preview}
        onOpenChange={(o) => {
          if (!o && !busy) setPreview(null);
        }}
      >
        <DialogContent className="schedule-import-dialog">
          <DialogHeader>
            <DialogTitle>CSV 반영 전 확인</DialogTitle>
            <DialogDescription>
              검증된 항목 전체를 한 번에 저장합니다. 실패하면 전체 반영을
              취소합니다.
            </DialogDescription>
          </DialogHeader>
          {preview && (
            <>
              <strong>
                {preview.kind === "participants_import"
                  ? `대기자 ${preview.participants.length}명 · 희망 일정 ${preview.requests.length}건`
                  : `${preview.date} · ${preview.entries.length}회기`}
              </strong>
              {preview.warnings.map((w, i) => (
                <p key={i}>{w}</p>
              ))}
              <div className="import-preview">
                {preview.kind === "participants_import"
                  ? preview.requests.slice(0, 10).map((r) => (
                      <p key={r.id}>
                        {r.participantId} · {r.desiredDate} · {r.therapyTypes} ·{" "}
                        {r.morningTimes} {r.afternoonTimes}
                      </p>
                    ))
                  : preview.entries.slice(0, 10).map((e) => (
                      <p key={e.id}>
                        {e.date} · {e.therapistId} · {e.startTime}–{e.endTime}
                      </p>
                    ))}
              </div>
              <p>처음 10건을 표시합니다. 날짜·가명 ID·시간을 확인해 주세요.</p>
              <Button
                disabled={busy}
                onClick={async () => {
                  if (await mutate(preview)) setPreview(null);
                }}
              >
                {busy ? "반영 중…" : "확인한 내용 반영"}
              </Button>
            </>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={templateOpen}
        onOpenChange={(o) => {
          if (!busy) setTemplateOpen(o);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>안내문 기본문구</DialogTitle>
            <DialogDescription>
              개인정보가 들어가지 않는 기본 문구를 선택하세요.
              날짜·시간·서비스만 자동 입력합니다.
            </DialogDescription>
          </DialogHeader>
          <Select value={template} onValueChange={setTemplate}>
            <SelectTrigger aria-label="안내문 선택">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {noticeTemplates.map((t, i) => (
                <SelectItem key={t} value={t}>
                  기본문구 {i + 1}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p>{template}</p>
          <Button
            disabled={busy}
            onClick={async () => {
              if (await mutate({ kind: "setting", value: template }))
                setTemplateOpen(false);
            }}
          >
            저장
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
function Field({
  label,
  value,
  onChange,
  type = "text",
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  disabled?: boolean;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <Input
        type={type}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
