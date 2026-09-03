CREATE TABLE `participant_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`participant_id` text NOT NULL,
	`submitted_at` text NOT NULL,
	`desired_date` text NOT NULL,
	`therapy_types` text NOT NULL,
	`morning_times` text DEFAULT '' NOT NULL,
	`afternoon_times` text DEFAULT '' NOT NULL,
	`status` text DEFAULT '처리 대기' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`source` text DEFAULT '대기 아동 CSV' NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
