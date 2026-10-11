import {
	bigint,
	index,
	integer,
	pgTable,
	smallint,
	text,
	timestamp,
	uniqueIndex
} from 'drizzle-orm/pg-core';

export const pixelPlacements = pgTable(
	'pixel_placements',
	{
		streamId: text('stream_id').primaryKey(),
		sequence: bigint('sequence', { mode: 'number' }).notNull(),
		userId: text('user_id').notNull(),
		offset: integer('offset').notNull(),
		color: smallint('color').notNull(),
		placementId: text('placement_id').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [
		uniqueIndex('pixel_placements_sequence_idx').on(table.sequence),
		index('pixel_placements_offset_idx').on(table.offset)
	]
);

export type PixelPlacement = typeof pixelPlacements.$inferSelect;
export type NewPixelPlacement = typeof pixelPlacements.$inferInsert;