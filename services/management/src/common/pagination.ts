import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import type { Filter, Sort } from 'mongodb';

/**
 * Keyset pagination on _id. Ids are time-ordered ULIDs, so "_id > cursor" is a stable
 * creation-order page even while new records arrive (no skip/offset drift).
 */
export class PageQuery {
  @IsOptional() @Transform(({ value }) => Number(value)) @IsInt() @Min(1) @Max(100) limit = 25;
  @IsOptional() @IsString() cursor?: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export function keysetFilter<T extends { _id: string }>(base: Filter<T>, cursor?: string): Filter<T> {
  return cursor ? ({ ...base, _id: { $gt: cursor } } as Filter<T>) : base;
}
export const keysetSort: Sort = { _id: 1 };

export function toPage<T extends { _id: string }>(rows: T[], limit: number): Page<T> {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? items[items.length - 1]!._id : null };
}
