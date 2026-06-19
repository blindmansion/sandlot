import { useCallback, useState } from "react";
import { useTheme } from "../context/ThemeContext";

export interface CounterProps {
	initial: number;
	step?: number;
}

export function Counter({ initial, step = 1 }: CounterProps) {
	const [count, setCount] = useState(initial);
	const theme = useTheme();

	const increment = useCallback(() => setCount((c) => c + step), [step]);
	const decrement = useCallback(() => setCount((c) => c - step), [step]);

	return (
		<section data-theme={theme.name}>
			<button type="button" onClick={decrement}>
				-
			</button>
			<output>{count}</output>
			<button type="button" onClick={increment}>
				+
			</button>
			<button type="button" onClick={theme.toggle}>
				theme: {theme.name}
			</button>
		</section>
	);
}
