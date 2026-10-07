import { IsEmail, IsString, Length, Matches, MaxLength } from 'class-validator';

/**
 * Every field is validated as a plain string of bounded length BEFORE it reaches a query: an object such as
 * {"$gt": ""} or {"$ne": null} (NoSQL operator injection) fails IsString/IsEmail and is rejected with 400 by the
 * global ValidationPipe (whitelist + forbidNonWhitelisted), so it can never become a MongoDB filter.
 */
export class LoginDto {
  @IsEmail() @MaxLength(254) email!: string;
  @IsString() @Length(8, 128) password!: string;
}
export class RegisterDto {
  @IsString() @Length(2, 80) @Matches(/^[^<>{}$]+$/, { message: 'name contains invalid characters' }) name!: string;
  @IsEmail() @MaxLength(254) email!: string;
  @IsString() @Length(8, 128) password!: string;
}
