import type { DatabasePort, PreparedQuery } from "./database-port";
import type {
  State,
  Slot,
  Participant,
  ParticipantRequest,
  ScheduleEntry,
  Audit,
} from "./domain";

export async function readState(db: DatabasePort): Promise<State> {
  await db
    .prepare(
      "INSERT OR IGNORE INTO system_settings(key,value) VALUES ('state_revision',?)",
    )
    .bind(crypto.randomUUID())
    .run();
  const results = await db.batch([
    db.prepare(
      "SELECT id,date,substr(time,1,5) AS startTime,substr(time,7,5) AS endTime,therapy_type AS type,therapist,status,assigned_participant AS assignedParticipant,notice_status AS noticeStatus,notice_text AS noticeText,assigned_at AS assignedAt,notice_completed_at AS noticeCompletedAt,revision FROM slots ORDER BY date,time,id",
    ),
    db.prepare(
      "SELECT id,therapy_type AS type,availability,waiting_since AS since,recent_connection AS recent,active FROM participants ORDER BY id",
    ),
    db.prepare(
      "SELECT id,participant_id AS participantId,submitted_at AS submittedAt,desired_date AS desiredDate,therapy_types AS therapyTypes,morning_times AS morningTimes,afternoon_times AS afternoonTimes,status,note FROM participant_requests",
    ),
    db.prepare(
      "SELECT id,date,weekday,department,therapist_id AS therapistId,therapist_name AS therapistName,start_time AS startTime,end_time AS endTime,treatment_code AS treatmentCode,import_batch AS importBatch FROM schedule_entries",
    ),
    db.prepare(
      "SELECT id,slot_id AS slotId,action,actor,detail,created_at AS createdAt FROM audit_logs ORDER BY id DESC LIMIT 100",
    ),
    db.prepare("SELECT key,value FROM system_settings"),
  ]);
  return {
    slots: results[0].results as unknown as Slot[],
    participants: (results[1].results as unknown as Participant[]).map((p) => ({
      ...p,
      active: Boolean(p.active),
    })),
    participantRequests: results[2].results as unknown as ParticipantRequest[],
    scheduleEntries: results[3].results as unknown as ScheduleEntry[],
    audit: results[4].results as unknown as Audit[],
    settings: Object.fromEntries(
      (results[5].results as { key: string; value: string }[]).map((r) => [
        r.key,
        r.value,
      ]),
    ),
  };
}

export async function commit(
  db: DatabasePort,
  version: string,
  operations: PreparedQuery[],
  actor: string,
  action: string,
  target: string,
  detail = "",
) {
  // Revision CAS and all changes are one D1 transaction. Guard trigger aborts the
  // entire batch if another coordinator changed any scheduling input meanwhile.
  const next = crypto.randomUUID();
  const revision = db
    .prepare(
      "UPDATE system_settings SET value=? WHERE key='state_revision' AND value=?",
    )
    .bind(next, version);
  const guard = db
    .prepare("INSERT INTO mutation_guards(id,expected_revision) VALUES (?,?)")
    .bind(next, next);
  try {
    await db.batch([
      revision,
      guard,
      ...operations,
      db
        .prepare(
          "INSERT INTO audit_logs(slot_id,action,actor,detail) VALUES (?,?,?,?)",
        )
        .bind(target, action, actor, detail),
      db.prepare("DELETE FROM mutation_guards WHERE id=?").bind(next),
    ]);
  } catch {
    throw new Error("mutation_conflict_or_storage_error");
  }
}
