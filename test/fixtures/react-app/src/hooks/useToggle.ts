import { useCallback, useState } from "react";

/** A tiny custom hook so the bundle/typecheck graph spans plain .ts modules too. */
export function useToggle(initial = false): [boolean, () => void] {
	const [on, setOn] = useState(initial);
	const toggle = useCallback(() => setOn((v) => !v), []);
	return [on, toggle];
}
