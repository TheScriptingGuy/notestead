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
