import { useMemo, useState } from "react";
import { WeekCalendar } from "./components/WeekCalendar";
import { NoteEditor } from "./components/NoteEditor";
import { NoteList } from "./components/NoteList";
import { addDays, fromISODate, toISODate } from "./dateUtils";
import { makeId, seedNotes } from "./sampleNotes";
import type { Note } from "./types";

const TODAY = new Date();

export function App() {
	const [notes, setNotes] = useState<Note[]>(() => seedNotes(TODAY));
	const [selectedDate, setSelectedDate] = useState<string>(toISODate(TODAY));
	const [weekAnchor, setWeekAnchor] = useState<string>(toISODate(TODAY));

	const countsByDate = useMemo(() => {
		const counts: Record<string, number> = {};
		for (const note of notes) {
			counts[note.date] = (counts[note.date] ?? 0) + 1;
		}
		return counts;
	}, [notes]);

	const notesForSelected = useMemo(
		() =>
			notes.filter((n) => n.date === selectedDate).sort((a, b) => a.id.localeCompare(b.id)),
		[notes, selectedDate],
	);

	function addNote(text: string) {
		setNotes((prev) => [...prev, { id: makeId(), date: selectedDate, text }]);
	}

	function deleteNote(id: string) {
		setNotes((prev) => prev.filter((n) => n.id !== id));
	}

	function shiftWeek(deltaWeeks: number) {
		setWeekAnchor((prev) => toISODate(addDays(fromISODate(prev), deltaWeeks * 7)));
	}

	function goToday() {
		const iso = toISODate(new Date());
		setWeekAnchor(iso);
		setSelectedDate(iso);
	}

	function selectDate(iso: string) {
		setSelectedDate(iso);
		setWeekAnchor(iso);
	}

	return (
		<div className="app">
			<header className="app__header">
				<h1>Weekly Notes</h1>
				<p className="app__subtitle">Jot a note on any day, see your week at a glance.</p>
			</header>

			<WeekCalendar
				weekAnchor={weekAnchor}
				selectedDate={selectedDate}
				countsByDate={countsByDate}
				onSelect={selectDate}
				onPrevWeek={() => shiftWeek(-1)}
				onNextWeek={() => shiftWeek(1)}
				onToday={goToday}
			/>

			<section className="day-panel">
				<NoteEditor selectedDate={selectedDate} onAdd={addNote} />
				<NoteList notes={notesForSelected} onDelete={deleteNote} />
			</section>
		</div>
	);
}
