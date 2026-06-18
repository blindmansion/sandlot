import { join } from "../util";
import type { ProjectRoot } from "../util";
import { satisfies } from "semver";
import { executeInstallPlan } from "./executor";
import type { InstallFileSystem } from "./fs";
import {
	generateLockfileFromPlan,
	readLockfile,
	writeLockfile,
} from "./lockfile";
import { createSpec, parseSpec } from "./registry";
import { resolveDependencies } from "./resolver";
import { DEFAULT_CONFIG, GLOBAL_STORE_PATH, type InstallResult } from "./types";

export interface ReconcileProjectOptions {
	project: ProjectRoot;
	fs: InstallFileSystem;
	desiredSpecs: string[];
	changedPackages?: Iterable<string>;
}

export interface ReconcileProjectResult {
	rootResults: InstallResult[];
	installed: InstallResult[];
	rootSpecs: string[];
}

function isTopLevelLockfilePath(path: string): boolean {
	return (
		path.startsWith("node_modules/") &&
		!path.slice("node_modules/".length).includes("node_modules/")
	);
}

function getTopLevelLockedVersions(
	packages: Record<string, { version: string }>,
): Map<string, string> {
	const versions = new Map<string, string>();

	for (const [path, entry] of Object.entries(packages)) {
		if (!isTopLevelLockfilePath(path)) continue;

		const name = path.slice("node_modules/".length);
		if (name) {
			versions.set(name, entry.version);
		}
	}

	return versions;
}

function preferLockedRootVersions(
	desiredSpecs: string[],
	lockedVersions: Map<string, string>,
	changedPackages: Set<string>,
): string[] {
	return desiredSpecs.map((spec) => {
		const parsed = parseSpec(spec);

		if (changedPackages.has(parsed.name)) {
			return spec;
		}

		const lockedVersion = lockedVersions.get(parsed.name);
		if (!lockedVersion) {
			return spec;
		}

		try {
			if (satisfies(lockedVersion, parsed.versionRange)) {
				return createSpec(parsed.name, lockedVersion);
			}
		} catch {
			return spec;
		}

		return spec;
	});
}

function toInstallResults(
	installed: Map<
		string,
		{ package: { name: string; version: string }; storePath: string }
	>,
): InstallResult[] {
	return Array.from(installed.values()).map((storePkg) => ({
		name: storePkg.package.name,
		version: storePkg.package.version,
		path: storePkg.storePath,
	}));
}

export async function reconcileProjectInstall(
	options: ReconcileProjectOptions,
): Promise<ReconcileProjectResult> {
	const { project, fs, desiredSpecs, changedPackages = [] } = options;
	const nodeModulesPath = join(project.root, "node_modules");
	const changed = new Set(changedPackages);
	const lockfile = await readLockfile(fs, project.root);
	const rootSpecs = lockfile?.packages
		? preferLockedRootVersions(
			desiredSpecs,
			getTopLevelLockedVersions(lockfile.packages),
			changed,
		)
		: desiredSpecs;

	await fs.rm(nodeModulesPath, { recursive: true, force: true });

	if (rootSpecs.length === 0) {
		await writeLockfile(
			fs,
			{
				name: project.name,
				lockfileVersion: 3,
				packages: {},
			},
			project.root,
		);

		return {
			rootResults: [],
			installed: [],
			rootSpecs,
		};
	}

	const config = {
		...DEFAULT_CONFIG,
		nodeModulesPath,
		storePath: GLOBAL_STORE_PATH,
	};
	const resolution = await resolveDependencies(rootSpecs, config);

	await executeInstallPlan(resolution.plan, {
		config,
		fs,
	});

	const nextLockfile = generateLockfileFromPlan(project.name, resolution.plan);
	await writeLockfile(fs, nextLockfile, project.root);

	const rootResults = rootSpecs
		.map((spec) => parseSpec(spec).name)
		.map((name) => resolution.tree.dependencies.get(name))
		.filter((node): node is NonNullable<typeof node> => node != null)
		.map((node) => {
			const key = `${node.package.name}@${node.package.version}`;
			const storePkg = resolution.plan.storePackages.get(key);
			return {
				name: node.package.name,
				version: node.package.version,
				path: storePkg?.storePath ?? "",
			};
		});

	return {
		rootResults,
		installed: toInstallResults(resolution.plan.storePackages),
		rootSpecs,
	};
}
