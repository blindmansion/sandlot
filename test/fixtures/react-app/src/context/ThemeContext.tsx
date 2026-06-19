import {
	createContext,
	type ReactNode,
	useContext,
	useMemo,
	useState,
} from "react";

export type ThemeName = "light" | "dark";

export interface Theme {
	name: ThemeName;
	toggle(): void;
}

const ThemeContext = createContext<Theme | null>(null);

export interface ThemeProviderProps {
	initial: ThemeName;
	children: ReactNode;
}

export function ThemeProvider({ initial, children }: ThemeProviderProps) {
	const [name, setName] = useState<ThemeName>(initial);
	const value = useMemo<Theme>(
		() => ({
			name,
			toggle: () => setName((n) => (n === "light" ? "dark" : "light")),
		}),
		[name],
	);

	return (
		<ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
	);
}

export function useTheme(): Theme {
	const ctx = useContext(ThemeContext);
	if (!ctx) {
		throw new Error("useTheme must be used within a ThemeProvider");
	}
	return ctx;
}
