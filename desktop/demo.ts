import type { DatabasePort } from "../lib/database-port";
import { readState } from "../lib/state-store";
import { executeAction } from "../lib/state-actions";
import { today, type ScheduleEntry } from "../lib/domain";

export async function seedDemo(db: DatabasePort) {
  if ((await readState(db)).participants.length) return;
  const d = new Date(`${today()}T00:00:00Z`);
  do { d.setUTCDate(d.getUTCDate() + 1); } while ([0, 6].includes(d.getUTCDay()));
  const date = d.toISOString().slice(0, 10);
  const apply = async (body: Record<string, unknown>) => executeAction({ ...body, version: (await readState(db)).settings.state_revision }, db, "체험 담당자");
  for (let i = 1; i <= 12; i++) {
    const since = new Date(d); since.setUTCDate(since.getUTCDate() - 120 + i);
    await apply({ kind: "participant", participant: {
      id: `대기자-DEMO${String(i).padStart(4, "0")}`, type: i <= 6 ? "작업치료" : "상담",
      availability: "평일 09:00–12:00", since: since.toISOString().slice(0, 10), recent: "없음", active: true,
    } });
  }
  const entries: ScheduleEntry[] = ["OT-01", "SW-01"].map((staff, i) => ({
    id: `${date}|${staff}|09:00`, date, weekday: "일월화수목금토"[d.getUTCDay()], department: i === 0 ? "작업치료" : "상담",
    therapistId: staff, therapistName: staff, startTime: "09:00", endTime: "09:30", treatmentCode: "DEMO", importBatch: "demo",
  }));
  await apply({ kind: "schedule_import", date, entries });
  for (const e of entries) await apply({ kind: "create", slot: { date, startTime: e.startTime, endTime: e.endTime, type: e.department, therapist: e.therapistId } });
}
