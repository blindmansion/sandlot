import { type FormEvent, useState } from "react";
import { formatLongDay } from "../dateUtils";

export interface NoteEditorProps {
	selectedDate: string;
	onAdd: (text: string) => void;
}

export function NoteEditor({ selectedDate, onAdd }: NoteEditorProps) {
	const [text, setText] = useState("");

	function submit(e: FormEvent) {
		e.preventDefault();
		const trimmed = text.trim();
		if (!trimmed) return;
		onAdd(trimmed);
		setText("");
	}

	return (
		<form className="editor" onSubmit={submit}>
			<label className="editor__day" htmlFor="note-input">
				{formatLongDay(selectedDate)}
			</label>
			<div className="editor__row">
				<input
					id="note-input"
					className="editor__input"
					type="text"
					placeholder="Add a note for this day…"
					value={text}
					onChange={(e) => setText(e.target.value)}
				/>
				<button type="submit" className="editor__add">
					Add
				</button>
			</div>
		</form>
	);
}
