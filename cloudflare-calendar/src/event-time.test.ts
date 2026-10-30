import { describe, expect, it } from 'vitest'
import { toZoned } from './event-time'

describe('toZoned', () => {
  it('keeps a zoned value as stored', () => {
    expect(toZoned('2026-10-29T09:00:00-07:00[America/Los_Angeles]', 'UTC').toString()).toBe('2026-10-29T09:00:00-07:00[America/Los_Angeles]')
  })
  it('reads an imported UTC instant in the tenant timezone', () => {
    expect(toZoned('2026-10-29T16:00:00.000Z', 'America/Los_Angeles').toString()).toBe('2026-10-29T09:00:00-07:00[America/Los_Angeles]')
  })
  it('reads an offset instant', () => {
    expect(toZoned('2026-10-29T09:00:00-07:00', 'America/Los_Angeles').toString()).toBe('2026-10-29T09:00:00-07:00[America/Los_Angeles]')
  })
  it('still rejects garbage', () => {
    expect(() => toZoned('not-a-date', 'UTC')).toThrow()
  })
})
