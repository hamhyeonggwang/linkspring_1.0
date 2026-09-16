import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
export const slots = sqliteTable("slots", {
  revision: integer("revision").notNull().default(0),
  id: text("id").primaryKey(),
  date: text("date").notNull(),
  time: text("time").notNull(),
  therapyType: text("therapy_type").notNull(),
  therapist: text("therapist").notNull(),
  candidateCount: integer("candidate_count").notNull().default(0),
  status: text("status").notNull().default("처리 대기"),
  assignedParticipant: text("assigned_participant"),
  noticeStatus: text("notice_status").notNull().default("미안내"),
  noticeText: text("notice_text").notNull().default(""),
  assignedAt: text("assigned_at"),
  noticeCompletedAt: text("notice_completed_at"),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});
export const mutationGuards = sqliteTable("mutation_guards", {
  id: text("id").primaryKey(),
  expectedRevision: text("expected_revision").notNull(),
});
export const participants = sqliteTable("participants", {
  id: text("id").primaryKey(),
  therapyType: text("therapy_type").notNull(),
  availability: text("availability").notNull(),
  waitingSince: text("waiting_since").notNull(),
  recentConnection: text("recent_connection").notNull().default("없음"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});
export const participantRequests = sqliteTable("participant_requests", {
  id: text("id").primaryKey(),
  participantId: text("participant_id").notNull(),
  submittedAt: text("submitted_at").notNull(),
  desiredDate: text("desired_date").notNull(),
  therapyTypes: text("therapy_types").notNull(),
  morningTimes: text("morning_times").notNull().default(""),
  afternoonTimes: text("afternoon_times").notNull().default(""),
  status: text("status").notNull().default("처리 대기"),
  note: text("note").notNull().default(""),
  source: text("source").notNull().default("대기 아동 CSV"),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});
export const auditLogs = sqliteTable("audit_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  slotId: text("slot_id").notNull(),
  action: text("action").notNull(),
  actor: text("actor").notNull().default("코디네이터 01"),
  detail: text("detail").notNull().default(""),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});
export const systemSettings = sqliteTable("system_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});
export const scheduleEntries = sqliteTable("schedule_entries", {
  id: text("id").primaryKey(),
  date: text("date").notNull(),
  weekday: text("weekday").notNull(),
  department: text("department").notNull(),
  therapistId: text("therapist_id").notNull(),
  therapistName: text("therapist_name").notNull(),
  startTime: text("start_time").notNull(),
  endTime: text("end_time").notNull(),
  treatmentCode: text("treatment_code").notNull(),
  importBatch: text("import_batch").notNull(),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});
