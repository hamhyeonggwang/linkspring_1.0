"use client";
import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { Button } from "./ui/button";
import {
  importParticipantsCsv,
  importScheduleCsv,
  importExpressions,
  type ImportOptions,
  type CsvPreview,
} from "../lib/institution-csv";
import {
  participantLabel,
  therapyTypes,
  type State,
  type ParticipantRequest,
} from "../lib/domain";

export type CsvFile = {
  text: string;
  name: string;
  kind: "participants" | "schedule";
};
const statuses: ParticipantRequest["status"][] = [
  "처리 대기",
  "처리 완료",
  "안내 완료",
  "추가 확인 필요",
  "신청 취소",
  "만료",
];
export function CsvImportDialog({
  file,
  state,
  busy,
  onClose,
  onApply,
}: {
  file: CsvFile;
  state: State;
  busy: boolean;
  onClose(): void;
  onApply(preview: CsvPreview): Promise<boolean>;
}) {
  const [options, setOptions] = useState<ImportOptions>(() => {
    try {
      return {
        ...JSON.parse(state.settings.csv_schedule_preferences || "{}"),
        statuses: {},
      };
    } catch {
      return {};
    }
  });
  const [excludedDates, setExcludedDates] = useState<string[]>([]);
  const result = useMemo(() => {
    try {
      return {
        preview:
          file.kind === "participants"
            ? importParticipantsCsv(file.text, state, options)
            : importScheduleCsv(file.text, state, options),
        error: "",
      };
    } catch (e) {
      return {
        preview: null,
        error: e instanceof Error ? e.message : "CSV를 읽지 못했습니다.",
      };
    }
  }, [file, state, options]);
  const expressions = useMemo(() => {
    try {
      return importExpressions(file.text, file.kind);
    } catch {
      return { therapies: [], statusRows: [] };
    }
  }, [file]);
  const preview = result.preview;
  const apply = async () => {
    if (!preview) return;
    let selected = preview;
    if (preview.kind === "schedule_import") {
      const dates = preview.dates.filter((d) => !excludedDates.includes(d));
      selected = {
        ...preview,
        dates,
        date: dates[0],
        entries: preview.entries.filter((e) => dates.includes(e.date)),
      };
    }
    // Preferences contain no notes or birthdates, only confirmed column interpretation.
    const payload =
      preview.kind === "schedule_import"
        ? {
            ...selected,
            preferences: {
              firstTime: options.firstTime,
              step: options.step,
              cells: options.cells,
              therapies: options.therapies,
            },
          }
        : selected;
    if (await onApply(payload)) onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="schedule-import-dialog csv-dialog">
        <DialogHeader>
          <DialogTitle>CSV 반영 전 확인</DialogTitle>
          <DialogDescription>
            {file.name} · 원본 파일은 저장하거나 외부로 보내지 않습니다.
          </DialogDescription>
        </DialogHeader>
        <div className="csv-scroll">
          {result.error && (
            <div className="import-warnings" role="alert">
              <strong>아직 반영하지 않았습니다.</strong>
              <p>{result.error}</p>
              <p>
                아래에서 양식의 의미를 확인하거나 CSV를 수정한 뒤 다시
                선택하세요.
              </p>
            </div>
          )}
          <details open={!!result.error} className="csv-options">
            <summary>기관 표현 연결 · 시간표 해석</summary>
            {file.kind === "schedule" && (
              <div className="csv-option-grid">
                <label>
                  제목 없는 시간 열의 첫 시각
                  <input
                    type="time"
                    value={options.firstTime || ""}
                    onChange={(e) =>
                      setOptions({
                        ...options,
                        firstTime: e.target.value || undefined,
                      })
                    }
                  />
                </label>
                <label>
                  시간 열 간격
                  <select
                    value={options.step || ""}
                    onChange={(e) =>
                      setOptions({
                        ...options,
                        step: e.target.value
                          ? Number(e.target.value)
                          : undefined,
                      })
                    }
                  >
                    <option value="">선택</option>
                    <option value={10}>10분</option>
                    <option value={30}>30분</option>
                  </select>
                </label>
                <label>
                  예약 코드 표기
                  <select
                    value={options.cells || "starts"}
                    onChange={(e) =>
                      setOptions({
                        ...options,
                        cells: e.target.value as "starts" | "filled",
                      })
                    }
                  >
                    <option value="starts">회기 시작 칸에만 표시</option>
                    <option value="filled">
                      회기 전체 칸에 같은 코드 반복
                    </option>
                  </select>
                </label>
              </div>
            )}
            <div className="csv-option-grid">
              {expressions.therapies.map((value) => (
                <label key={value}>
                  치료 표현: {value}
                  <select
                    value={options.therapies?.[value] || ""}
                    onChange={(e) =>
                      setOptions({
                        ...options,
                        therapies: {
                          ...options.therapies,
                          [value]: e.target.value,
                        },
                      })
                    }
                  >
                    <option value="">자동 인식</option>
                    {therapyTypes.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            {!!expressions.statusRows.length && (
              <details>
                <summary>
                  비고에 따른 상태 확인 ({expressions.statusRows.length}행)
                </summary>
                <p>
                  원본 비고를 확인하고 필요한 행만 상태를 선택하세요. 비고
                  원문은 저장되지 않습니다.
                </p>
                <div className="csv-option-grid">
                  {expressions.statusRows.map(({ row, value }) => (
                    <label key={row}>
                      {row}행 처리 상태
                      <select
                        value={options.statuses?.[value] || ""}
                        onChange={(e) =>
                          setOptions({
                            ...options,
                            statuses: {
                              ...options.statuses,
                              [value]: e.target
                                .value as ParticipantRequest["status"],
                            },
                          })
                        }
                      >
                        <option value="">자동 인식</option>
                        {statuses.map((s) => (
                          <option key={s}>{s}</option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
              </details>
            )}
          </details>
          {preview && (
            <>
              <p>
                <strong>{preview.format}</strong> · 원본 {preview.sourceCount}행
              </p>
              {preview.kind === "participants_import" ? (
                <>
                  <p>
                    대기자 {preview.participants.length}명 · 희망 일정{" "}
                    {preview.requests.length}건 · 신규{" "}
                    {
                      preview.participants.filter(
                        (p) =>
                          !state.participants.some((old) => old.id === p.id),
                      ).length
                    }
                    명
                  </p>
                  <p>
                    타임스탬프는 보강 신청일입니다. 익명 표시는 유지하며 별도의
                    가명 ID 열은 필요하지 않습니다.
                  </p>
                  <div className="csv-table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>익명 표시</th>
                          <th>희망 날짜</th>
                          <th>치료</th>
                          <th>오전</th>
                          <th>오후</th>
                          <th>상태</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.requests.slice(0, 100).map((r) => (
                          <tr key={r.id}>
                            <td>
                              {participantLabel(
                                preview.participants.find(
                                  (p) => p.id === r.participantId,
                                )!,
                              )}
                            </td>
                            <td>{r.desiredDate}</td>
                            <td>{r.therapyTypes}</td>
                            <td>{r.morningTimes || "—"}</td>
                            <td>{r.afternoonTimes || "—"}</td>
                            <td>{r.status}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <>
                  <p>
                    예약 {preview.entries.length}건 · 치료사{" "}
                    {new Set(preview.entries.map((e) => e.therapistId)).size}명
                  </p>
                  <div className="csv-dates">
                    {preview.dates.map((d) => (
                      <label key={d}>
                        <input
                          type="checkbox"
                          checked={!excludedDates.includes(d)}
                          onChange={(e) =>
                            setExcludedDates((v) =>
                              e.target.checked
                                ? v.filter((x) => x !== d)
                                : [...v, d],
                            )
                          }
                        />
                        {d} ·{" "}
                        {preview.entries.filter((e) => e.date === d).length}건
                      </label>
                    ))}
                  </div>
                  <div className="csv-table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>날짜</th>
                          <th>치료사</th>
                          <th>시간</th>
                          <th>치료</th>
                          <th>예약 코드</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.entries
                          .filter((e) => !excludedDates.includes(e.date))
                          .slice(0, 100)
                          .map((e) => (
                            <tr key={e.id}>
                              <td>{e.date}</td>
                              <td>{e.therapistName}</td>
                              <td>
                                {e.startTime}–{e.endTime}
                              </td>
                              <td>{e.department}</td>
                              <td>{e.treatmentCode}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
              <p>미리보기는 최대 100건까지 표시합니다.</p>
              <ul className="import-warnings">
                {preview.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </>
          )}
        </div>
        <div className="csv-actions">
          <Button variant="outline" disabled={busy} onClick={onClose}>
            취소
          </Button>
          <Button
            disabled={
              busy ||
              !preview ||
              (preview.kind === "schedule_import" &&
                preview.dates.every((d) => excludedDates.includes(d)))
            }
            onClick={() => void apply()}
          >
            {busy ? "반영 중…" : "확인한 내용 반영"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
