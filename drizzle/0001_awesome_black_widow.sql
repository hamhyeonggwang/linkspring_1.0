ALTER TABLE `slots` ADD `notice_status` text DEFAULT '미안내' NOT NULL;--> statement-breakpoint
ALTER TABLE `slots` ADD `notice_text` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `slots` ADD `assigned_at` text;--> statement-breakpoint
ALTER TABLE `slots` ADD `notice_completed_at` text;