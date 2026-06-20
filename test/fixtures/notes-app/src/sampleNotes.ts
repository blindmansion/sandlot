import { addDays, toISODate } from "./dateUtils";
import type { Note } from "./types";

let counter = 0;
export function makeId(): string {
	counter += 1;
	return `n${Date.now().toString(36)}-${counter}`;
}

/** A few notes anchored around today so the current week starts populated. */
export function seedNotes(today: Date): Note[] {
	return [
		{ id: makeId(), date: toISODate(today), text: "Ship the weekly calendar view" },
		{ id: makeId(), date: toISODate(today), text: "Review HMR patch behavior" },
		{
			id: makeId(),
			date: toISODate(addDays(today, -2)),
			text: "Sketch the note data model",
		},
		{
			id: makeId(),
			date: toISODate(addDays(today, 1)),
			text: "Demo the app to the team",
		},
	];
}
