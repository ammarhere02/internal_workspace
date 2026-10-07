import { IsIn, IsInt, IsOptional, IsString, Length, Matches, Min } from 'class-validator';
import { PageQuery } from '../../common/pagination.js';
import { ROLES, type Role } from '../teams.types.js';

export class CreateTeamDto {
  @IsString() @Length(2, 80) name!: string;
  /** Short upper-case code, unique per workspace, e.g. PAY. */
  @IsString() @Matches(/^[A-Z][A-Z0-9]{1,9}$/, { message: 'code must be 2-10 upper-case letters/digits' }) code!: string;
  @IsOptional() @IsString() @Length(0, 500) description = '';
}
export class UpdateTeamDto {
  @IsInt() @Min(1) expectedVersion!: number;
  @IsOptional() @IsString() @Length(2, 80) name?: string;
  @IsOptional() @IsString() @Length(0, 500) description?: string;
}
export class ArchiveDto {
  @IsInt() @Min(1) expectedVersion!: number;
}
export class AddMemberDto {
  @IsString() userId!: string;
  @IsIn(ROLES) role: Role = 'MEMBER';
}
export class ChangeRoleDto {
  @IsIn(ROLES) role!: Role;
}
export class ListTeamsQuery extends PageQuery {
  @IsOptional() @IsIn(['true', 'false']) includeArchived?: string;
}
