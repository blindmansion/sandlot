import type { Note } from "../types";

export interface NoteListProps {
	notes: Note[];
	onDelete: (id: string) => void;
}

export function NoteList({ notes, onDelete }: NoteListProps) {
	if (notes.length === 0) {
		return <p className="notes__empty">No notes yet for this day.</p>;
	}

	return (
		<ul className="notes">
			{notes.map((note) => (
				<li key={note.id} className="note">
					<span className="note__text">{note.text}</span>
					<button
						type="button"
						className="note__delete"
						aria-label="Delete note"
						onClick={() => onDelete(note.id)}
					>
						×
					</button>
				</li>
			))}
		</ul>
	);
}
