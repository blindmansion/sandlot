import { Counter } from "./components/Counter";
import { type TodoItem, TodoList } from "./components/TodoList";
import { ThemeProvider } from "./context/ThemeContext";
import { useToggle } from "./hooks/useToggle";

const SEED_TODOS: TodoItem[] = [
	{ id: 1, label: "Wire up the bundler", done: true },
	{ id: 2, label: "Profile the typechecker", done: false },
	{ id: 3, label: "Ship the widget", done: false },
];

export function App() {
	const [expanded, toggleExpanded] = useToggle(true);

	return (
		<ThemeProvider initial="light">
			<main>
				<h1>React widgets</h1>
				<button type="button" onClick={toggleExpanded}>
					{expanded ? "Hide" : "Show"} widgets
				</button>
				{expanded && (
					<>
						<Counter initial={0} step={2} />
						<TodoList initialItems={SEED_TODOS} />
					</>
				)}
			</main>
		</ThemeProvider>
	);
}
