/**
 * Publish cadence arithmetic (§19).
 *
 * Split from `service.ts` because it is pure functions over dates and the service
 * talks to Postgres: the rule that decides *when* a channel's next video starts
 * can then be tested exhaustively — including the two days a year that break naive
 * implementations — without a database.
 *
 * The settings this works from are a user's wall clock, not an instant:
 * `publishDays` (0 = Sunday), `publishTimes` (`HH:MM`) and an IANA `timezone`.
 * "Monday at 18:00 in Europe/London" is a different instant in January and in
 * July, and storing the January answer would drift an hour every spring. So the
 * slot is resolved against the zone every time it is computed.
 *
 * No date library. `Intl.DateTimeFormat` with a `timeZone` is the platform's own
 * tzdata, already loaded, and it is what makes the offset solve below correct
 * across DST without shipping a copy of the zone database.
 */

/** A `HH:MM` string. Validated by `automationPatchSchema` before it lands here. */
type TimeOfDay = string;

export interface Cadence {
  /** 0 = Sunday … 6 = Saturday. */
  publishDays: number[];
  publishTimes: TimeOfDay[];
  /** IANA zone name. An unrecognised one falls back to UTC rather than throwing. */
  timezone: string;
}

/** How far ahead `nextSlot` will look before giving up. */
const SEARCH_DAYS = 15;

/**
 * The next cadence slot strictly after `after`, or null when the cadence is empty.
 *
 * Strictly after, not at-or-after: this is called immediately after a slot has
 * been claimed, and returning the same instant would claim it again on the next
 * tick.
 */
export function nextSlot(cadence: Cadence, after: Date): Date | null {
  const days = normaliseDays(cadence.publishDays);
  const times = normaliseTimes(cadence.publishTimes);
  if (days.length === 0 || times.length === 0) return null;

  const zone = safeZone(cadence.timezone);
  const from = after.getTime();

  /**
   * Walk forward a *local* day at a time from the zone's current date. Walking
   * local days rather than adding 24-hour blocks is what makes a DST transition
   * a non-event: 02:30 on the spring-forward date simply does not exist, and the
   * offset solve below lands on 03:30 instead of silently going backwards.
   */
  const start = zonedParts(from, zone);

  for (let offset = 0; offset <= SEARCH_DAYS; offset += 1) {
    const local = addLocalDays(start, offset);
    if (!days.includes(local.weekday)) continue;

    for (const time of times) {
      const [hours, minutes] = time;
      const candidate = zonedTimeToInstant(
        { year: local.year, month: local.month, day: local.day, hours, minutes },
        zone,
      );
      if (candidate > from) return new Date(candidate);
    }
  }

  return null;
}

/**
 * Whether a channel's cadence would ever fire. Used to explain a configuration
 * that looks enabled but cannot produce a run.
 */
export function cadenceIsRunnable(cadence: Cadence): boolean {
  return (
    normaliseDays(cadence.publishDays).length > 0 &&
    normaliseTimes(cadence.publishTimes).length > 0
  );
}

/** Sorted, de-duplicated, in range. Anything else is dropped, not clamped. */
function normaliseDays(days: readonly number[]): number[] {
  const seen = new Set<number>();
  for (const day of days) {
    if (!Number.isInteger(day) || day < 0 || day > 6) continue;
    seen.add(day);
  }
  return [...seen].sort((a, b) => a - b);
}

/** `HH:MM` → `[hours, minutes]`, sorted by time of day. Invalid entries dropped. */
function normaliseTimes(times: readonly string[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const seen = new Set<string>();

  for (const raw of times) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
    if (!match) continue;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) continue;
    const key = `${hours}:${minutes}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([hours, minutes]);
  }

  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/**
 * A zone name `Intl` accepts, or UTC.
 *
 * A bad zone must not stop automation: the column is a free-text varchar, an
 * unrecognised value is an old or mistyped setting, and running at the wrong hour
 * is a far smaller failure than never running at all. The caller logs the
 * substitution.
 */
export function safeZone(timezone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return timezone;
  } catch {
    return "UTC";
  }
}

interface LocalDate {
  year: number;
  /** 1-12, matching what `Intl` reports rather than `Date`'s 0-11. */
  month: number;
  day: number;
  /** 0 = Sunday. */
  weekday: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(zone);
  if (cached) return cached;
  // Constructing one of these is not cheap and the scheduler does it per channel
  // per tick, so they are cached by zone. There are a few hundred zones; the map
  // is bounded by `safeZone` having already rejected anything else.
  const made = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour12: false,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  formatterCache.set(zone, made);
  return made;
}

/** The wall-clock date an instant shows in a zone. */
function zonedParts(instant: number, zone: string): LocalDate {
  const parts = new Map<string, string>();
  for (const part of formatter(zone).formatToParts(new Date(instant))) {
    parts.set(part.type, part.value);
  }

  const weekdayName = parts.get("weekday") ?? "Sun";
  const weekday = WEEKDAYS.findIndex((d) => d === weekdayName);

  return {
    year: Number(parts.get("year") ?? "1970"),
    month: Number(parts.get("month") ?? "1"),
    day: Number(parts.get("day") ?? "1"),
    weekday: weekday < 0 ? 0 : weekday,
  };
}

/**
 * Advance a local calendar date by whole days.
 *
 * Done through `Date.UTC` purely as calendar arithmetic — no zone is involved,
 * because "the day after the 31st" is the same question in every zone. The
 * weekday comes back out of the same arithmetic rather than being incremented,
 * which keeps it right across a month boundary.
 */
function addLocalDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
  };
}

interface LocalTime {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
}

/**
 * A wall-clock time in a zone → the UTC instant it names.
 *
 * A zone's offset depends on the instant, and the instant is what we are solving
 * for, so this iterates: guess the offset at a first approximation, apply it, then
 * re-derive the offset at the corrected instant and apply that. One of the two
 * results is the answer for every wall clock that exists.
 *
 * Which one cannot be assumed, so each is *verified* by formatting it back and
 * comparing to the wall clock asked for. Iterating without that check is the trap:
 * on a spring-forward date the second pass re-derives the post-transition offset
 * and re-applies it, converging an hour *before* the gap — 02:30 in New York on
 * 2026-03-08 would resolve to 01:30 EST. Moving a slot backwards is the worse
 * direction, because in a zone that transitions at midnight it lands on the
 * previous local day and fires on a weekday the user never chose.
 *
 * So when neither candidate round-trips, the wall clock does not exist and the
 * later instant is taken: the requested time shifted forward by the size of the
 * gap, which is 03:30 local for a skipped 02:30. That is what every calendar
 * application does with a reminder set inside a gap, and it matches how `luxon`
 * resolves the same case.
 *
 * A wall clock that occurs *twice* (the autumn repeat) resolves to the second
 * occurrence — whichever the iteration settles on. Both are the time the user
 * asked for, and an hour's difference once a year on one slot does not justify
 * probing the transition table to prefer the first.
 */
function zonedTimeToInstant(local: LocalTime, zone: string): number {
  const asUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hours,
    local.minutes,
  );

  const first = asUtc - zoneOffsetMs(asUtc, zone);
  const second = asUtc - zoneOffsetMs(first, zone);
  if (second === first) return first;

  if (showsWallClock(second, local, zone)) return second;
  if (showsWallClock(first, local, zone)) return first;

  // Neither exists: a gap. Forward, never backward.
  return Math.max(first, second);
}

/** Whether an instant displays exactly this wall clock in this zone. */
function showsWallClock(instant: number, local: LocalTime, zone: string): boolean {
  const parts = new Map<string, string>();
  for (const part of formatter(zone).formatToParts(new Date(instant))) {
    parts.set(part.type, part.value);
  }

  return (
    Number(parts.get("year")) === local.year &&
    Number(parts.get("month")) === local.month &&
    Number(parts.get("day")) === local.day &&
    // `hour12: false` still reports midnight as "24" in some ICU versions, so the
    // modulo is load-bearing rather than defensive.
    Number(parts.get("hour")) % 24 === local.hours &&
    Number(parts.get("minute")) === local.minutes
  );
}

/**
 * `wall clock in zone − UTC`, in milliseconds, at a given instant.
 *
 * Positive east of Greenwich. Derived by formatting the instant in the zone and
 * reading the difference, which is the only way to get a *historical* offset
 * without a copy of tzdata.
 */
function zoneOffsetMs(instant: number, zone: string): number {
  const parts = new Map<string, string>();
  for (const part of formatter(zone).formatToParts(new Date(instant))) {
    parts.set(part.type, part.value);
  }

  const wall = Date.UTC(
    Number(parts.get("year") ?? "1970"),
    Number(parts.get("month") ?? "1") - 1,
    Number(parts.get("day") ?? "1"),
    Number(parts.get("hour") ?? "0") % 24,
    Number(parts.get("minute") ?? "0"),
    Number(parts.get("second") ?? "0"),
  );

  // Rounded to the minute: the formatter has no sub-second field, so the raw
  // difference carries the instant's own milliseconds as noise.
  return Math.round((wall - instant) / 60_000) * 60_000;
}
