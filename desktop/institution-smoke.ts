import type { BrowserWindow } from "electron";
import type { State } from "../lib/domain";

// Executed inside the isolated renderer, using real file inputs and UI actions.
async function institutionUiScenario() {
  const wait = async (check: () => unknown, label: string) => {
    const end = Date.now() + 10000;
    while (!check()) {
      if (Date.now() > end) throw new Error(`UI timeout: ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  };
  const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === label && !b.disabled,
    );
  const click = async (label: string) => {
    await wait(() => button(label), label);
    button(label)!.click();
  };
  const state = async () => (await window.linkspring!.call("state")) as State;
  const upload = async (csv: string) => {
    await wait(() => document.querySelector("input[type=file]"), "file input");
    const input = document.querySelector<HTMLInputElement>("input[type=file]")!;
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([csv], "institution-test.csv", { type: "text/csv" }),
    );
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await wait(() => document.querySelector(".csv-dialog"), "import preview");
  };
  await click("실제 업무 시작");
  await wait(() => !document.querySelector(".desktop-overlay") && !document.querySelector(".desktop-busy") && document.querySelector(".page-header"), "workspace ready");
  await click("대기자 관리");
  const participants =
    "타임스탬프,아동이름,아동 생년월일,보강치료 희망 날짜,치료,오전,오후,비고\n2025. 1. 2. 오후 1:30:00,아동001,2018-04-05,2030-01-07,작업,09:00~11:00,,";
  await upload(participants.replace("09:00~11:00", "잘못된 시간"));
  await wait(
    () => document.querySelector(".csv-dialog [role=alert]"),
    "validation error",
  );
  if ((await state()).participants.length !== 0)
    throw new Error("Preview wrote data");
  await click("취소");
  await wait(() => !document.querySelector(".csv-dialog"), "cancel preview");
  await upload(participants);
  if (
    document.querySelector(".csv-dialog")!.textContent!.includes("2018-04-05")
  )
    throw new Error("Birthdate in preview");
  await click("확인한 내용 반영");
  await wait(
    () => !document.querySelector(".csv-dialog"),
    "apply participants",
  );
  const id = (await state()).participants[0].id;
  await upload(participants);
  await click("확인한 내용 반영");
  await wait(() => !document.querySelector(".csv-dialog"), "repeat import");
  if (
    (await state()).participants.length !== 1 ||
    (await state()).participants[0].id !== id
  )
    throw new Error("Duplicate identity");
  await click("치료 일정");
  await upload(
    "Unnamed,일자,요일,부서,아이디,치료사,건수,08:30,09:00,09:30\n0,2030-01-07,월,작업,001,치료사01,2,,r001,r002",
  );
  await click("확인한 내용 반영");
  await wait(
    () =>
      !document.querySelector(".csv-dialog") &&
      document.querySelector(".session-booked"),
    "timetable",
  );
  if (
    !document
      .querySelector(".therapist-schedule")!
      .textContent!.includes("치료사01")
  )
    throw new Error("Source label lost");
  (document.querySelector(".session-booked") as HTMLButtonElement).click();
  await click("결석 여부·수정 내용 확인 후 등록");
  await wait(() => document.querySelector(".queue-card"), "absence created");
  (document.querySelector(".queue-card") as HTMLButtonElement).click();
  await wait(
    () => document.querySelector(".candidate:not(:disabled)"),
    "candidate",
  );
  (
    document.querySelector(".candidate:not(:disabled)") as HTMLButtonElement
  ).click();
  const confirm = window.confirm;
  try {
    window.confirm = () => true;
    await click("담당자 확인 후 연결 확정");
  } finally {
    window.confirm = confirm;
  }
  await click("실제 안내 완료로 기록");
  await wait(
    () =>
      document
        .querySelector(".candidate-dialog")
        ?.textContent?.includes("안내 완료"),
    "notice",
  );
  const after = await state();
  if (
    after.slots[0].assignedParticipant !== id ||
    after.slots[0].noticeStatus !== "안내 완료"
  )
    throw new Error("UI workflow not persisted");
  await wait(() => button("결석·빈 회기 등록"), "save finished");
  (
    document.querySelector(
      '.candidate-dialog [data-slot="dialog-close"]',
    ) as HTMLButtonElement
  )?.click();
  await wait(
    () => !document.querySelector(".candidate-dialog"),
    "close result",
  );
  await click("치료 일정");
  await wait(
    () => document.querySelector(".session-connected"),
    "connected timetable",
  );
  return {
    previewValidation: true,
    noBirthdateInPreview: true,
    identityStable: true,
    therapistMatrix: true,
    absenceFromCell: true,
    candidateAndConfirmation: true,
    noticeRecorded: true,
  };
}
export async function runInstitutionSmoke(window: BrowserWindow) {
  return window.webContents.executeJavaScript(
    `(${institutionUiScenario.toString()})()`,
  );
}
