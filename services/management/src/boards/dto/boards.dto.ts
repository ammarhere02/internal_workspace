import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, Min, ValidateIf, ValidateNested } from 'class-validator';
import { PageQuery } from '../../common/pagination.js';
import { IsDateOnly } from '../../common/validators.js';
import { ITEM_TYPES, PRIORITIES, type ItemType, type Priority } from '../boards.types.js';

const LABEL = /^[a-z0-9][a-z0-9-]{0,29}$/;

export class CreateItemDto {
  @IsString() @Length(1, 200) title!: string;
  @IsOptional() @IsString() @Length(0, 5000) description = '';
  @IsOptional() @IsString() @Length(0, 5000) acceptanceNotes = '';
  @IsIn(ITEM_TYPES) type: ItemType = 'TASK';
  @IsIn(PRIORITIES) priority: Priority = 'MEDIUM';
  @IsOptional() @IsString() assigneeId?: string | null;
  @IsOptional() @IsString() columnId?: string; // defaults to the first column
  @IsOptional() @IsArray() @ArrayMaxSize(10) @Matches(LABEL, { each: true, message: 'labels are lower-case slugs' }) labels: string[] = [];
  @IsOptional() @IsDateOnly() dueDate?: string | null;
}
export class UpdateItemDto {
  @IsInt() @Min(1) expectedVersion!: number;
  @IsOptional() @IsString() @Length(1, 200) title?: string;
  @IsOptional() @IsString() @Length(0, 5000) description?: string;
  @IsOptional() @IsString() @Length(0, 5000) acceptanceNotes?: string;
  @IsOptional() @IsIn(ITEM_TYPES) type?: ItemType;
  @IsOptional() @IsIn(PRIORITIES) priority?: Priority;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @Matches(LABEL, { each: true }) labels?: string[];
  @ValidateIf((o) => o.dueDate !== null) @IsOptional() @IsDateOnly() dueDate?: string | null;
}
export class AssignItemDto {
  @IsInt() @Min(1) expectedVersion!: number;
  /** null = unassign */
  @ValidateIf((o) => o.assigneeId !== null) @IsString() assigneeId!: string | null;
}
export class MoveItemDto {
  @IsInt() @Min(1) expectedVersion!: number;
  @IsString() toColumnId!: string;
  /** Place after this card in the target column. null = top of column. Omitted = bottom. */
  @IsOptional() @ValidateIf((o) => o.afterItemId !== null) @IsString() afterItemId?: string | null;
}
export class ArchiveItemDto {
  @IsInt() @Min(1) expectedVersion!: number;
}
export class ListItemsQuery extends PageQuery {
  @IsOptional() @IsString() assigneeId?: string; // 'unassigned' selects null
  @IsOptional() @IsIn(PRIORITIES) priority?: Priority;
  @IsOptional() @IsIn(ITEM_TYPES) type?: ItemType;
  @IsOptional() @Matches(LABEL) label?: string;
  @IsOptional() @IsString() @Length(1, 100) q?: string;
  @IsOptional() @IsString() columnId?: string;
  @IsOptional() @IsIn(['true', 'false']) includeArchived?: string;
}
export class ColumnInputDto {
  @IsOptional() @IsString() columnId?: string; // omitted = new column
  @IsString() @Length(1, 40) name!: string;
  @IsOptional() @ValidateIf((o) => o.wipLimit !== null) @IsInt() @Min(1) @Max(999) wipLimit?: number | null;
}
export class UpdateColumnsDto {
  @IsInt() @Min(1) expectedVersion!: number;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(12) @ValidateNested({ each: true }) @Type(() => ColumnInputDto) columns!: ColumnInputDto[];
}
