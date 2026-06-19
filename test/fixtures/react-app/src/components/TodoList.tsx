import { useMemo, useReducer } from "react";

export interface TodoItem {
	id: number;
	label: string;
	done: boolean;
}

type TodoAction =
	| { type: "toggle"; id: number }
	| { type: "add"; item: TodoItem };

function todoReducer(state: TodoItem[], action: TodoAction): TodoItem[] {
	switch (action.type) {
		case "toggle":
			return state.map((t) =>
				t.id === action.id ? { ...t, done: !t.done } : t,
			);
		case "add":
			return [...state, action.item];
		default:
			return state;
	}
}

export interface TodoListProps {
	initialItems: TodoItem[];
}

export function TodoList({ initialItems }: TodoListProps) {
	const [items, dispatch] = useReducer(todoReducer, initialItems);
	const remaining = useMemo(() => items.filter((t) => !t.done).length, [items]);

	return (
		<section>
			<p>{remaining} remaining</p>
			<ul>
				{items.map((item) => (
					<li key={item.id}>
						<label>
							<input
								type="checkbox"
								checked={item.done}
								onChange={() => dispatch({ type: "toggle", id: item.id })}
							/>
							{item.label}
						</label>
					</li>
				))}
			</ul>
		</section>
	);
}
