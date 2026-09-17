ALTER TABLE participants ADD external_code TEXT;
--> statement-breakpoint
ALTER TABLE participants ADD import_source TEXT NOT NULL DEFAULT 'manual';
--> statement-breakpoint
CREATE UNIQUE INDEX participants_external_code ON participants(import_source,external_code) WHERE external_code IS NOT NULL;
--> statement-breakpoint
ALTER TABLE participant_requests ADD submitted_time TEXT;
--> statement-breakpoint
CREATE TABLE schedule_staff (
  id TEXT PRIMARY KEY NOT NULL,
  external_code TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  department TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
