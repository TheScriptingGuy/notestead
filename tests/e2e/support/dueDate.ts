// Due dates for the to-do tests (docs/test-plans/M2-S2.md D5): the wall clock of an epoch in a given zone, computed with
// Intl and an explicit timeZone, so the host's own zone never matters.
export const userTimeZone = 'Europe/Amsterdam';

export interface LocalParts { year: string; month: string; day: string; hour: string; minute: string }

export const partsIn = (epochMs: number, timeZone: string): LocalParts => {
	const parts = new Intl.DateTimeFormat('en-GB', {
		timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
	}).formatToParts(new Date(epochMs));
	const of = (type: Intl.DateTimeFormatPartTypes): string => parts.find(p => p.type === type)?.value ?? '';
	return { year: of('year'), month: of('month'), day: of('day'), hour: of('hour'), minute: of('minute') };
};

export const datetimeLocalValue = (p: LocalParts): string => `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;

// The first whole minute at or after now + aheadMs (datetime-local has minute precision).
export const nextWholeMinute = (nowMs: number, aheadMs: number): number => Math.ceil((nowMs + aheadMs) / 60_000) * 60_000;

// False when the zone's wall clock of `epochMs` also names another instant 30 or 60 minutes away: the repeated hour when
// summer time ends. A datetime-local value cannot tell the two apart, and the browser takes the first (M2-S2 r1 C2).
export const wallClockIsUnique = (epochMs: number, timeZone: string): boolean => {
	const own = datetimeLocalValue(partsIn(epochMs, timeZone));
	return [-60, -30, 30, 60].every(m => datetimeLocalValue(partsIn(epochMs + m * 60_000, timeZone)) !== own);
};

// The epoch of 12:00 local time on the local calendar day `days` after the local date of `nowMs` (docs/test-plans/M2-S4.md
// D10). Noon is never in a skipped or repeated hour. Found by searching the hour offsets -14..+14; throws unless exactly one
// instant matches.
export const localNoonEpoch = (nowMs: number, days: number, timeZone: string): number => {
	const today = partsIn(nowMs, timeZone);
	const target = new Date(Date.UTC(Number(today.year), Number(today.month) - 1, Number(today.day) + days));
	const wanted = `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, '0')}-${String(target.getUTCDate()).padStart(2, '0')}T12:00`;
	const utcNoon = Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate(), 12);
	const matches: number[] = [];
	for (let offset = -14; offset <= 14; offset++) {
		const candidate = utcNoon + offset * 3_600_000;
		if (datetimeLocalValue(partsIn(candidate, timeZone)) === wanted) matches.push(candidate);
	}
	if (matches.length !== 1) throw new Error(`${matches.length} instants are ${wanted} in ${timeZone}`);
	return matches[0];
};
