import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import Home from "../app/page";
import {
  today,
  therapyTypes,
  clock,
  minutes,
  type State,
  type ScheduleEntry,
} from "../lib/domain";
import type { AISettings, DesktopInfo, Operation } from "../shared/desktop";
import "../app/globals.css";
import "./desktop.css";

async function call<T>(op: Operation, data?: unknown): Promise<T> {
  if (!window.linkspring)
    throw new Error(
      "데스크톱 연결을 시작하지 못했습니다. 앱을 다시 실행하세요.",
    );
  return window.linkspring.call(op, data) as Promise<T>;
}
function DesktopApp() {
  const [info, setInfo] = useState<DesktopInfo>();
  const [refresh, setRefresh] = useState(0);
  const [panel, setPanel] = useState<"help" | "schedule" | "settings" | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [settings, setSettings] = useState<AISettings>({
    model: "",
    enabled: false,
    hasKey: false,
  });
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [date, setDate] = useState(today());
  const [start, setStart] = useState("09:00");
  const [service, setService] = useState<string>("작업치료");
  const [staff, setStaff] = useState("OT-01");
  useEffect(() => {
    void call<DesktopInfo>("info")
      .then((value) => {
        setInfo(value);
        if (!localStorage.getItem("linkspring-onboarding-complete"))
          setPanel("help");
      })
      .catch((e) => setMessage(e.message));
  }, []);
  const perform = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      await work();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "처리하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };
  const switchMode = (mode: "work" | "demo") =>
    perform(async () => {
      localStorage.setItem("linkspring-onboarding-complete", "1");
      setInfo(await call<DesktopInfo>("workspace", mode));
      setRefresh((v) => v + 1);
      setPanel(null);
      setMessage(
        mode === "demo"
          ? "가상의 12명과 다음 평일의 빈 일정 2개가 준비되었습니다. 왼쪽 처리 대기에서 연결을 체험하세요."
          : "실제 업무 저장소로 전환했습니다. 기관 내 익명 코드만 입력해 주세요.",
      );
    });
  const schedule = async (event: React.FormEvent) => {
    event.preventDefault();
    await perform(async () => {
      const state = await call<State>("state");
      const entry: ScheduleEntry = {
        id: `${date}|${staff}|${start}`,
        date,
        weekday: "",
        department: service as ScheduleEntry["department"],
        therapistId: staff,
        therapistName: staff,
        startTime: start,
        endTime: clock(minutes(start) + 30),
        treatmentCode: "MANUAL",
        importBatch: "manual",
      };
      if (state.scheduleEntries.some((e) => e.id === entry.id))
        throw new Error("이미 같은 날짜·담당자·시각의 일정이 있습니다.");
      await call("mutate", {
        kind: "schedule_import",
        version: state.settings.state_revision,
        date,
        entries: [
          ...state.scheduleEntries.filter((e) => e.date === date),
          entry,
        ],
      });
      setRefresh((v) => v + 1);
      setMessage(
        "치료 일정에 등록했습니다. 결석으로 비게 된 회기는 ‘빈 회기 등록’에서 같은 정보를 입력하세요.",
      );
      setPanel(null);
    });
  };
  const desktopControls = (
    <div className="desktop-status">
      <strong>
        {info?.workspace === "demo"
          ? "예시 체험 · 가상 데이터"
          : "이 PC의 실제 업무 데이터"}
      </strong>
      <details className="desktop-settings">
        <summary>앱 설정 · 백업</summary>
        <button
          disabled={busy || !info}
          onClick={() =>
            void switchMode(info?.workspace === "demo" ? "work" : "demo")
          }
        >
          {info?.workspace === "demo" ? "실제 업무로 전환" : "예시로 체험"}
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              const r = await call<{ canceled?: boolean; path?: string }>(
                "backup",
              );
              if (!r.canceled) setMessage(`백업 완료: ${r.path}`);
            })
          }
        >
          백업
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              const r = await call<{
                canceled?: boolean;
                safetyBackup?: string;
              }>("restore");
              if (!r.canceled) {
                setRefresh((v) => v + 1);
                setMessage(`복원 완료. 이전 데이터 백업: ${r.safetyBackup}`);
              }
            })
          }
        >
          복원
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              setSettings(await call<AISettings>("settings"));
              setKey("");
              setClearKey(false);
              setPanel("settings");
            })
          }
        >
          Claude 설정
        </button>
        <button disabled={busy} onClick={() => setPanel("help")}>
          사용 안내
        </button>
      </details>
    </div>
  );
  return (
    <>
      {message && (
        <div className="desktop-message" role="status">
          {message}
          <button aria-label="메시지 닫기" onClick={() => setMessage("")}>
            닫기
          </button>
        </div>
      )}
      {info && (
        <Home
          key={`${info.workspace}-${refresh}`}
          desktopControls={desktopControls}
          onManualSchedule={() => setPanel("schedule")}
        />
      )}
      {busy && (
        <div className="desktop-busy" role="status">
          처리 중입니다…
        </div>
      )}
      {panel && (
        <div className="desktop-overlay">
          <section
            className="desktop-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="desktop-title"
          >
            <button
              className="desktop-close"
              disabled={busy}
              onClick={() => {
                localStorage.setItem("linkspring-onboarding-complete", "1");
                setPanel(null);
              }}
              aria-label="창 닫기"
            >
              닫기
            </button>
            {panel === "help" && (
              <>
                <h1 id="desktop-title">이어:봄에 오신 것을 환영합니다</h1>
                <p>
                  치료·상담·교육 등 비영리 서비스의 빈 일정과 기다리는 대기자의
                  기회를 연결합니다.
                </p>
                <ol>
                  <li>
                    <b>처음이라면 ‘예시로 체험’</b>을 선택하세요. 실제 업무
                    데이터와 분리된 가상 데이터로 연결과 안내 기록을 연습할 수
                    있습니다.
                  </li>
                  <li>
                    <b>치료 일정</b>은 ‘일정 직접 등록’ 또는 치료 일정 메뉴의
                    CSV 가져오기로 입력하세요.
                  </li>
                  <li>
                    <b>대기자 관리</b>에서 익명 코드·이용 가능 시간·서비스를
                    등록하세요. 별도 Python 전처리 없이 직접 입력할 수 있습니다.
                  </li>
                  <li>
                    <b>빈 회기 등록 → 후보 확인 → 연결 확정 → 안내 완료 기록</b>{" "}
                    순으로 처리하세요. 문자나 전화가 자동 발송되지는 않습니다.
                  </li>
                  <li>
                    <b>업무 종료 전 백업</b>하세요. 데이터는 이 PC에만 저장되며,
                    다른 PC와 자동 공유되지 않습니다.
                  </li>
                </ol>
                <p className="desktop-note">
                  무료 규칙 분석과 매칭은 인터넷과 API 키 없이 동작합니다.
                  실명·연락처·진단명은 입력하지 말고 기관 내부 명단과 연결되는
                  익명 코드를 사용하세요. 이 앱은 기관 계정/접근권한 시스템을
                  제공하지 않으므로 PC의 사용자 계정과 잠금 기능으로 접근을
                  관리하세요. 백업에는 업무 이력이 포함되므로 안전한 장소에
                  보관하세요.
                </p>
                <p className="desktop-path">
                  현재 저장 위치: {info?.path || "연결 중…"}
                  <br />
                  버전: {info?.version}
                </p>
                <div className="desktop-actions">
                  <button
                    disabled={busy || !info}
                    onClick={() => void switchMode("demo")}
                  >
                    예시로 체험
                  </button>
                  <button
                    disabled={busy || !info}
                    onClick={() => void switchMode("work")}
                  >
                    실제 업무 시작
                  </button>
                  {info?.workspace === "demo" && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void perform(async () => {
                          const result = await call<{ canceled?: boolean }>(
                            "demoReset",
                          );
                          if (!result.canceled) {
                            setRefresh((v) => v + 1);
                            setPanel(null);
                          }
                        })
                      }
                    >
                      체험 초기화
                    </button>
                  )}
                </div>
              </>
            )}
            {panel === "schedule" && (
              <form onSubmit={schedule}>
                <h1 id="desktop-title">치료 일정 직접 등록</h1>
                <p>
                  담당자의 운영 시간표에 30분 회기를 추가합니다. 기관 내 익명
                  담당자 코드를 사용하세요.
                </p>
                <label>
                  날짜
                  <input
                    required
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                  />
                </label>
                <label>
                  시작 시각 (08:30~17:30, 점심 12~13시 제외)
                  <input
                    required
                    type="time"
                    step="1800"
                    value={start}
                    onChange={(e) => setStart(e.target.value)}
                  />
                </label>
                <label>
                  서비스
                  <select
                    value={service}
                    onChange={(e) => setService(e.target.value)}
                  >
                    {therapyTypes.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </label>
                <label>
                  담당자 코드
                  <input
                    required
                    maxLength={29}
                    value={staff}
                    onChange={(e) => setStaff(e.target.value.toUpperCase())}
                    placeholder="OT-01 / SW-01 / ED-01"
                  />
                </label>
                <button disabled={busy} type="submit">
                  일정 저장
                </button>
              </form>
            )}
            {panel === "settings" && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void perform(async () => {
                    setSettings(
                      await call<AISettings>("saveSettings", {
                        ...settings,
                        apiKey: key || undefined,
                        clearKey,
                      }),
                    );
                    setKey("");
                    setClearKey(false);
                    setPanel(null);
                    setMessage("Claude 설정을 저장했습니다.");
                  });
                }}
              >
                <h1 id="desktop-title">Claude 선택 기능</h1>
                <p>
                  기본 업무는 설정 없이 이용할 수 있습니다. 활성화하면 분석
                  버튼을 눌렀을 때 추출한 일정 토큰과 기준일을 Anthropic으로
                  전송합니다. 본인 API 계정에 이용 요금이 발생할 수 있습니다.
                  체험 모드에서는 항상 규칙 분석을 사용합니다.
                </p>
                <label className="desktop-checkbox">
                  <input
                    type="checkbox"
                    checked={settings.enabled}
                    onChange={(e) =>
                      setSettings({ ...settings, enabled: e.target.checked })
                    }
                  />
                  외부 전송을 이해하고 실제 업무에서 Claude 사용
                </label>
                <label>
                  API 키{" "}
                  {settings.hasKey ? "(저장됨 · 비워두면 유지)" : "(미설정)"}
                  <input
                    type="password"
                    autoComplete="off"
                    maxLength={512}
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                  />
                </label>
                <label>
                  모델 ID (본인 Anthropic 계정에서 이용 가능한 값)
                  <input
                    maxLength={120}
                    value={settings.model}
                    placeholder="사용할 Claude 모델 ID"
                    onChange={(e) =>
                      setSettings({ ...settings, model: e.target.value })
                    }
                  />
                </label>
                <label className="desktop-checkbox">
                  <input
                    type="checkbox"
                    checked={clearKey}
                    onChange={(e) => setClearKey(e.target.checked)}
                  />
                  저장된 API 키 삭제
                </label>
                <p className="desktop-note">
                  키는 Windows 사용자 계정에 연결된 암호화 저장소를 사용하며,
                  데이터 백업이나 설치파일에 포함되지 않습니다. 연결 실패 시
                  규칙 분석으로 전환됩니다.
                </p>
                <button disabled={busy} type="submit">
                  설정 저장
                </button>
              </form>
            )}
            {message && (
              <p role="alert" className="desktop-form-error">
                {message}
              </p>
            )}
          </section>
        </div>
      )}
    </>
  );
}
createRoot(document.getElementById("root")!).render(<DesktopApp />);
