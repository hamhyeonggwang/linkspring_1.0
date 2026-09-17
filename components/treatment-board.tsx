"use client";
import { useState, type CSSProperties } from "react";
import { Button } from "./ui/button";
import {
  sessionTimes,
  staffLabel,
  type State,
  type ScheduleEntry,
} from "../lib/domain";

export function TreatmentBoard({
  state,
  date,
  onDate,
  onImport,
  onSlot,
  onAbsence,
  onManual,
}: {
  state: State;
  date: string;
  onDate(date: string): void;
  onImport(): void;
  onSlot(id: string): void;
  onAbsence(entry: ScheduleEntry): void;
  onManual?: () => void;
}) {
  const [emptyOnly, setEmptyOnly] = useState(false);
  const dates = [...new Set(state.scheduleEntries.map((e) => e.date))].sort();
  const day = date || dates[0] || "";
  const entries = state.scheduleEntries.filter((e) => e.date === day);
  const ids = [...new Set(entries.map((e) => e.therapistId))].sort(
    (a, b) =>
      (state.staff?.find((s) => s.id === a)?.position ?? 999) -
      (state.staff?.find((s) => s.id === b)?.position ?? 999),
  );
  return (
    <section>
      <div className="section-head">
        <div>
          <h2>{day ? `${day} 치료 일정` : "당일 치료 일정"}</h2>
          <p>치료사별 예약과 결석으로 발생한 빈 회기를 확인합니다.</p>
        </div>
        <div className="inline-actions">
          <Button variant="outline" onClick={onImport}>
            당일 시간표 CSV 불러오기
          </Button>
          {onManual && (
            <Button variant="outline" onClick={onManual}>
              일정 직접 등록
            </Button>
          )}
          <Button
            variant={emptyOnly ? "default" : "outline"}
            onClick={() => setEmptyOnly((v) => !v)}
          >
            {emptyOnly ? "전체 일정 보기" : "빈 회기만 보기"}
          </Button>
        </div>
      </div>
      <div className="schedule-import-summary">
        <label>
          날짜{" "}
          <select
            aria-label="시간표 날짜"
            value={day}
            onChange={(e) => onDate(e.target.value)}
          >
            {!dates.length && <option value="">등록된 날짜 없음</option>}
            {date && !dates.includes(date) && (
              <option value={date}>{date}</option>
            )}
            {dates.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </label>
        <strong>
          {ids.length}명 · 예약 {entries.length}건
        </strong>
        <span>08:30–12:00 / 13:00–18:00 · 30분 회기</span>
      </div>
      {!!entries.length && (
        <>
          <div
            className="therapist-schedule"
            role="region"
            aria-label="치료사별 시간표"
            tabIndex={0}
          >
            <div
              className="schedule-row schedule-header"
              style={
                { "--session-count": sessionTimes.length } as CSSProperties
              }
            >
              <strong>치료사</strong>
              {sessionTimes.map((t) => (
                <span key={t}>{t}</span>
              ))}
            </div>
            {ids.map((id) => (
              <div
                key={id}
                className="schedule-row"
                style={
                  { "--session-count": sessionTimes.length } as CSSProperties
                }
              >
                <strong
                  title={
                    state.staff?.find((s) => s.id === id)?.externalCode || id
                  }
                >
                  {staffLabel(state, id)}
                </strong>
                {sessionTimes.map((t) => {
                  const entry = entries.find(
                    (e) => e.therapistId === id && e.startTime === t,
                  );
                  const slot = state.slots.find(
                    (s) =>
                      s.date === day && s.therapist === id && s.startTime === t,
                  );
                  const open = slot && slot.status !== "연결 완료";
                  const hidden = emptyOnly && !open;
                  const label = slot
                    ? slot.status === "연결 완료"
                      ? "연결 완료"
                      : slot.status === "추가 확인 필요"
                        ? "확인 필요"
                        : "빈 회기"
                    : entry?.treatmentCode || "—";
                  return (
                    <button
                      key={t}
                      disabled={hidden || (!entry && !slot)}
                      className={
                        hidden
                          ? "session-hidden"
                          : slot?.status === "연결 완료"
                            ? "session-connected"
                            : open
                              ? "session-empty"
                              : entry
                                ? "session-booked"
                                : "session-unassigned"
                      }
                      aria-label={`${staffLabel(state, id)} ${t} ${hidden ? "숨김" : label}`}
                      onClick={() =>
                        slot ? onSlot(slot.id) : entry && onAbsence(entry)
                      }
                    >
                      <span>{hidden ? "" : label}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="schedule-legend">
            <span>
              <i className="legend-booked" />
              예약 코드
            </span>
            <span>
              <i className="legend-empty" />
              결석으로 발생한 빈 회기
            </span>
            <span>
              <i className="legend-connected" />
              연결 완료
            </span>
            <span>— 미배정 · 빈 셀은 결석이 아닙니다</span>
          </div>
        </>
      )}
      {!entries.length && (
        <div className="schedule-upload-empty">
          <strong>당일 익명 시간표를 불러와 주세요.</strong>
          <p>기관의 원래 열 이름과 예약 코드를 그대로 읽습니다.</p>
          <Button onClick={onImport}>CSV 파일 선택</Button>
        </div>
      )}
    </section>
  );
}
