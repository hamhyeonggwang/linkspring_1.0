CREATE TABLE `schedule_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`weekday` text NOT NULL,
	`department` text NOT NULL,
	`therapist_id` text NOT NULL,
	`therapist_name` text NOT NULL,
	`start_time` text NOT NULL,
	`end_time` text NOT NULL,
	`treatment_code` text NOT NULL,
	`import_batch` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
