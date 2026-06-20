export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const MONTH_LABELS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

/** Format a Date as a local ISO calendar day (YYYY-MM-DD), no timezone shift. */
export function toISODate(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

/** Parse a YYYY-MM-DD string into a local Date at midnight. */
export function fromISODate(iso: string): Date {
	const [y, m, day] = iso.split("-").map(Number);
	return new Date(y, m - 1, day);
}

export function addDays(d: Date, n: number): Date {
	const next = new Date(d);
	next.setDate(next.getDate() + n);
	return next;
}

/** Sunday-anchored start of the week containing `d`. */
export function startOfWeek(d: Date): Date {
	return addDays(d, -d.getDay());
}

/** The seven Date objects for the week containing `anchor`. */
export function weekDays(anchor: Date): Date[] {
	const start = startOfWeek(anchor);
	return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export function isSameISODay(a: Date, iso: string): boolean {
	return toISODate(a) === iso;
}

/** e.g. "Jun 14 – 20, 2026" for the week containing `anchor`. */
export function formatWeekRange(anchor: Date): string {
	const days = weekDays(anchor);
	const first = days[0];
	const last = days[6];
	const firstMonth = MONTH_LABELS[first.getMonth()];
	const lastMonth = MONTH_LABELS[last.getMonth()];
	if (first.getMonth() === last.getMonth()) {
		return `${firstMonth} ${first.getDate()} – ${last.getDate()}, ${last.getFullYear()}`;
	}
	return `${firstMonth} ${first.getDate()} – ${lastMonth} ${last.getDate()}, ${last.getFullYear()}`;
}

/** e.g. "Saturday, June 20" for a given ISO day. */
export function formatLongDay(iso: string): string {
	const d = fromISODate(iso);
	const weekday = [
		"Sunday",
		"Monday",
		"Tuesday",
		"Wednesday",
		"Thursday",
		"Friday",
		"Saturday",
	][d.getDay()];
	return `${weekday}, ${MONTH_LABELS[d.getMonth()]} ${d.getDate()}`;
}
