import { IsISO8601, IsOptional, ValidationOptions, registerDecorator } from 'class-validator';

/** YYYY-MM-DD, used for dueDate/startDate/targetDate. Dates without time avoid timezone surprises in the UI. */
export function IsDateOnly(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isDateOnly', target: object.constructor, propertyName, options,
      validator: { validate: (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)),
        defaultMessage: () => `${propertyName} must be a YYYY-MM-DD date` },
    });
}
export { IsISO8601, IsOptional };
