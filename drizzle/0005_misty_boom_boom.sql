CREATE TABLE `mutation_guards` (
	`id` text PRIMARY KEY NOT NULL,
	`expected_revision` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `slots` ADD `revision` integer DEFAULT 0 NOT NULL;