import { IsIn, IsInt, IsOptional, IsString, Length, Matches, Min } from 'class-validator';
import { PageQuery } from '../../common/pagination.js';
import { IsDateOnly } from '../../common/validators.js';
import { PROJECT_STATUSES, type ProjectStatus } from '../projects.types.js';

export class CreateProjectDto {
  /** Immutable: issue keys are derived from it (PAY-104). */
  @IsString() @Matches(/^[A-Z][A-Z0-9]{1,9}$/, { message: 'projectKey must be 2-10 upper-case letters/digits' }) projectKey!: string;
  @IsString() @Length(2, 120) name!: string;
  @IsOptional() @IsString() @Length(0, 2000) description = '';
  @IsString() teamId!: string;
  @IsOptional() @IsString() ownerId?: string; // defaults to the actor
  @IsOptional() @IsIn(PROJECT_STATUSES) status: ProjectStatus = 'PLANNED';
  @IsOptional() @IsDateOnly() startDate?: string;
  @IsOptional() @IsDateOnly() targetDate?: string;
}
export class UpdateProjectDto {
  @IsInt() @Min(1) expectedVersion!: number;
  @IsOptional() @IsString() @Length(2, 120) name?: string;
  @IsOptional() @IsString() @Length(0, 2000) description?: string;
  @IsOptional() @IsIn(PROJECT_STATUSES) status?: ProjectStatus;
  @IsOptional() @IsDateOnly() startDate?: string | null;
  @IsOptional() @IsDateOnly() targetDate?: string | null;
  @IsOptional() @IsString() ownerId?: string;
}
export class AssignTeamDto {
  @IsInt() @Min(1) expectedVersion!: number;
  @IsString() teamId!: string;
}
export class ArchiveProjectDto {
  @IsInt() @Min(1) expectedVersion!: number;
}
export class ListProjectsQuery extends PageQuery {
  @IsOptional() @IsIn(['true', 'false']) includeArchived?: string;
  @IsOptional() @IsString() teamId?: string;
}
