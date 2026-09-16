CREATE TABLE `audit_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slot_id` text NOT NULL,
	`action` text NOT NULL,
	`actor` text DEFAULT '코디네이터 01' NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `participants` (
	`id` text PRIMARY KEY NOT NULL,
	`therapy_type` text NOT NULL,
	`availability` text NOT NULL,
	`waiting_since` text NOT NULL,
	`recent_connection` text DEFAULT '없음' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `slots` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`time` text NOT NULL,
	`therapy_type` text NOT NULL,
	`therapist` text NOT NULL,
	`candidate_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT '처리 대기' NOT NULL,
	`assigned_participant` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
