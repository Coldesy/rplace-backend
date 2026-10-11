CREATE TABLE "pixel_placements" (
	"stream_id" text PRIMARY KEY NOT NULL,
	"sequence" bigint NOT NULL,
	"user_id" text NOT NULL,
	"offset" integer NOT NULL,
	"color" smallint NOT NULL,
	"placement_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "pixel_placements_sequence_idx" ON "pixel_placements" USING btree ("sequence");--> statement-breakpoint
CREATE INDEX "pixel_placements_offset_idx" ON "pixel_placements" USING btree ("offset");