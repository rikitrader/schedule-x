import { Temporal } from 'temporal-polyfill'

/** The API accepts zoned values and plain instants (imports store UTC), but ZonedDateTime.from only parses zoned ones. */
export const toZoned = (value: string, timezone: string) =>
  value.includes('[') ? Temporal.ZonedDateTime.from(value) : Temporal.Instant.from(value).toZonedDateTimeISO(timezone)
