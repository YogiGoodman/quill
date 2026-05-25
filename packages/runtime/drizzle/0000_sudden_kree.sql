CREATE TABLE `branches` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`parent_branch_id` text,
	`forked_from_step` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_branch_id`) REFERENCES `branches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`branch_id` text NOT NULL,
	`step_id` text NOT NULL,
	`type` text NOT NULL,
	`determinism` text,
	`semantic_name` text NOT NULL,
	`loop_index` integer DEFAULT 0 NOT NULL,
	`payload_json` text,
	`idempotency_key` text,
	`cost_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_step_terminal` ON `events` (`branch_id`,`step_id`,`type`);--> statement-breakpoint
CREATE INDEX `by_branch_seq` ON `events` (`branch_id`,`id`);--> statement-breakpoint
CREATE INDEX `by_idem_key` ON `events` (`idempotency_key`);--> statement-breakpoint
CREATE TABLE `interventions` (
	`id` text PRIMARY KEY NOT NULL,
	`branch_id` text NOT NULL,
	`step_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`status` text NOT NULL,
	`input_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
