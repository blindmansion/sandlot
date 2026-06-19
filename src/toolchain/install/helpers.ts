import type { InstallFileSystem } from "./fs";

export { getProjectRoot, type ProjectRoot } from "../util";

// ---------------------------------------------------------------------------
// package.json dependency helpers
// ---------------------------------------------------------------------------

/** Dependency sections to scan, in priority order */
const DEP_SECTIONS = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
] as const;

/** The dependency section names in package.json */
export type DepType =
	| "dependencies"
	| "devDependencies"
	| "optionalDependencies";

export interface DeclaredDep {
	name: string;
	range: string;
	section: DepType;
}

export function getDeclaredDeps(
	packageJson: Record<string, unknown>,
): DeclaredDep[] {
	const deps: DeclaredDep[] = [];

	for (const section of DEP_SECTIONS) {
		const block = packageJson[section];
		if (block && typeof block === "object" && !Array.isArray(block)) {
			for (const [name, range] of Object.entries(
				block as Record<string, string>,
			)) {
				deps.push({ name, range, section });
			}
		}
	}

	return deps;
}

/**
 * Extract all dependency specs from a parsed package.json as install-ready
 * strings (e.g. `["nanoid@^4.0.0", "vitest@^1.0.0"]`).
 *
 * Reads `dependencies`, `devDependencies`, and `optionalDependencies`.
 */
export function readDepsFromPackageJson(
	packageJson: Record<string, unknown>,
): string[] {
	const specs: string[] = [];

	for (const dep of getDeclaredDeps(packageJson)) {
		specs.push(`${dep.name}@${dep.range}`);
	}

	return specs;
}

/**
 * Extract the range prefix (`^`, `~`, `>=`, etc.) from a version range string.
 * Returns an empty string for exact versions.
 */
function getVersionPrefix(range: string): string {
	const match = range.match(/^([~^]|>=?|<=?)/);
	return match?.[1] ?? "";
}

/**
 * Add or update packages in a specific dependency section of package.json.
 *
 * When `exact` is true the resolved version is written as-is (e.g. `"4.1.2"`).
 * Otherwise, if the package already exists in the section its existing prefix
 * is preserved; new packages default to a caret range (e.g. `"^4.1.2"`).
 */
export async function saveToPackageJson(
	fs: InstallFileSystem,
	packageJsonPath: string,
	packages: Array<{ name: string; version: string }>,
	depType: DepType,
	exact: boolean,
): Promise<void> {
	const raw = await fs.readFile(packageJsonPath);
	const packageJson = JSON.parse(raw) as Record<string, unknown>;

	const section = (packageJson[depType] ?? {}) as Record<string, string>;

	for (const pkg of packages) {
		if (exact) {
			section[pkg.name] = pkg.version;
		} else {
			const existing = section[pkg.name];
			const prefix = existing != null ? getVersionPrefix(existing) : "^";
			section[pkg.name] = `${prefix}${pkg.version}`;
		}
	}

	const sorted: Record<string, string> = {};
	for (const key of Object.keys(section).sort()) {
		sorted[key] = section[key] as string;
	}
	packageJson[depType] = sorted;

	await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));
}

/**
 * Remove packages from **all** dependency sections of package.json.
 * Returns the list of package names that were actually found and removed.
 */
export async function removeFromPackageJson(
	fs: InstallFileSystem,
	packageJsonPath: string,
	packageNames: string[],
): Promise<string[]> {
	const raw = await fs.readFile(packageJsonPath);
	const packageJson = JSON.parse(raw) as Record<string, unknown>;

	const removed: string[] = [];

	for (const section of DEP_SECTIONS) {
		const deps = packageJson[section] as Record<string, string> | undefined;
		if (!deps) continue;

		for (const name of packageNames) {
			if (name in deps) {
				delete deps[name];
				if (!removed.includes(name)) removed.push(name);
			}
		}

		if (Object.keys(deps).length === 0) {
			delete packageJson[section];
		}
	}

	await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));
	return removed;
}
