/**
 * Apocentro: free-input custom timer for disappearing messages.
 *
 * Session only offers a handful of fixed presets (12h / 1 day / 1 week / 2 weeks).
 * Android grew a "Custom time" row on top of those, and this is the same thing for
 * desktop -- the stored value is a plain number of seconds either way, so a custom
 * duration is understood by every other client without any wire change.
 *
 * Kept byte-for-byte in step with `CustomTimeUnit` in
 * `conversation/disappearingmessages/State.kt` on Android.
 */

export type CustomTimeUnit = 'minutes' | 'hours' | 'days';

export const CUSTOM_TIME_UNITS: Array<CustomTimeUnit> = ['minutes', 'hours', 'days'];

const SECONDS_IN: Record<CustomTimeUnit, number> = {
  minutes: 60,
  hours: 3600,
  days: 86400,
};

/** The duration described by an amount + unit, or null when the amount is not usable. */
export function customDurationSeconds(amount: string, unit: CustomTimeUnit): number | null {
  const parsed = Number(amount);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed * SECONDS_IN[unit];
}

/**
 * Splits a persisted duration back into the amount + unit that produced it, so a
 * conversation already set to a non-preset time reopens with the custom row filled in.
 * Same rounding rules as Android: exact days, else exact hours, else minutes rounded up.
 */
export function splitIntoCustomTime(seconds: number): { amount: number; unit: CustomTimeUnit } {
  if (seconds % SECONDS_IN.days === 0) {
    return { amount: seconds / SECONDS_IN.days, unit: 'days' };
  }
  if (seconds % SECONDS_IN.hours === 0) {
    return { amount: seconds / SECONDS_IN.hours, unit: 'hours' };
  }
  return { amount: Math.ceil(seconds / SECONDS_IN.minutes), unit: 'minutes' };
}
