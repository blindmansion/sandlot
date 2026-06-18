/**
 * Registry client for fetching package data from npm
 *
 * Uses native fetch() and nanotar for browser compatibility.
 */

import { dirname, join } from "../util";
import { parseTarGzip } from "nanotar";
import { maxSatisfying } from "semver";
import type { InstallFileSystem } from "./fs";
import type {
	DependencySpec,
	PeerDependencyMeta,
	ResolvedPackage,
} from "./types";

export interface RegistryOptions {
	registry: string;
}

export interface ExtractOptions {
	registry: string;
	/** Filesystem to use for extraction */
	fs: InstallFileSystem;
}

/**
 * Raw packument from npm registry
 */
interface NpmPackument {
	name: string;
	"dist-tags": Record<string, string>;
	versions: Record<string, NpmManifest>;
}

/**
 * Raw manifest from npm registry
 */
interface NpmManifest {
	name: string;
	version: string;
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	peerDependenciesMeta?: Record<string, PeerDependencyMeta>;
	dist: {
		tarball: string;
		integrity?: string;
		shasum?: string;
	};
}

/**
 * Cache for packuments to avoid re-fetching during resolution
 */
const packumentCache = new Map<string, NpmPackument>();

/**
 * Encode a package name for use in a URL
 * Scoped packages like @types/node become @types%2Fnode
 */
function encodePackageName(name: string): string {
	if (name.startsWith("@")) {
		// Scoped package: encode the slash but keep the @
		const [scope, pkg] = name.slice(1).split("/");
		return `@${scope}%2F${pkg}`;
	}
	return name;
}

/**
 * Fetch the full packument (all versions) from the registry
 */
async function fetchFullPackument(
	packageName: string,
	options: RegistryOptions,
): Promise<NpmPackument> {
	// Check cache first
	const cacheKey = `${options.registry}:${packageName}`;
	const cached = packumentCache.get(cacheKey);
	if (cached) {
		return cached;
	}

	const url = `${options.registry}/${encodePackageName(packageName)}`;

	const res = await fetch(url, {
		headers: {
			Accept: "application/json",
		},
	});

	if (!res.ok) {
		if (res.status === 404) {
			throw new Error(`Package not found: ${packageName}`);
		}
		throw new Error(
			`Failed to fetch ${packageName}: ${res.status} ${res.statusText}`,
		);
	}

	const packument = (await res.json()) as NpmPackument;

	// Cache it
	packumentCache.set(cacheKey, packument);

	return packument;
}

/**
 * Fetch the manifest for a package spec (resolves version ranges)
 */
export async function fetchManifest(
	spec: string,
	options: RegistryOptions,
): Promise<ResolvedPackage> {
	const { name, versionRange } = parseSpec(spec);
	const packument = await fetchFullPackument(name, options);

	// Resolve version
	let version: string | null;

	if (versionRange === "latest") {
		version = packument["dist-tags"]?.latest || null;
	} else if (packument["dist-tags"]?.[versionRange]) {
		// It's a dist-tag like "next" or "beta"
		version = packument["dist-tags"][versionRange];
	} else {
		// It's a semver range - find the best matching version
		const versions = Object.keys(packument.versions || {});
		version = maxSatisfying(versions, versionRange);
	}

	if (!version) {
		throw new Error(`No version matching ${spec} (range: ${versionRange})`);
	}

	const manifest = packument.versions[version];
	if (!manifest) {
		throw new Error(`Version ${version} not found in packument for ${name}`);
	}

	// Convert dependencies object to our DependencySpec array
	const dependencies: DependencySpec[] = Object.entries(
		manifest.dependencies || {},
	).map(([depName, depVersionRange]) => ({
		name: depName,
		versionRange: depVersionRange,
	}));

	// Convert optionalDependencies object to our DependencySpec array
	const optionalDependencies: DependencySpec[] = Object.entries(
		manifest.optionalDependencies || {},
	).map(([depName, depVersionRange]) => ({
		name: depName,
		versionRange: depVersionRange,
	}));

	// Convert peerDependencies object to our DependencySpec array
	const peerDependencies: DependencySpec[] = Object.entries(
		manifest.peerDependencies || {},
	).map(([depName, depVersionRange]) => ({
		name: depName,
		versionRange: depVersionRange,
	}));

	// Extract peerDependenciesMeta (marks some peer deps as optional)
	const peerDependenciesMeta: Record<string, PeerDependencyMeta> =
		manifest.peerDependenciesMeta || {};

	return {
		name: manifest.name,
		version: manifest.version,
		dependencies,
		optionalDependencies,
		peerDependencies,
		peerDependenciesMeta,
		integrity: manifest.dist?.integrity || "",
		tarballUrl: manifest.dist?.tarball || "",
		resolved: manifest.dist?.tarball || "",
	};
}

/**
 * Fetch the full packument (all versions) for a package
 * Public API for CLI info command
 */
export async function fetchPackument(
	packageName: string,
	options: RegistryOptions,
): Promise<{
	name: string;
	versions: string[];
	distTags: Record<string, string>;
	latest: string;
}> {
	const packument = await fetchFullPackument(packageName, options);

	return {
		name: packument.name,
		versions: Object.keys(packument.versions || {}),
		distTags: packument["dist-tags"] || {},
		latest: packument["dist-tags"]?.latest || "",
	};
}

/**
 * Extract a package to a destination directory
 * Downloads the tarball and extracts it using nanotar
 */
export async function extractPackage(
	spec: string,
	destPath: string,
	options: ExtractOptions,
): Promise<{ integrity: string }> {
	const { fs, registry } = options;

	// Get manifest to find tarball URL
	const manifest = await fetchManifest(spec, { registry });
	const tarballUrl = manifest.tarballUrl;

	if (!tarballUrl) {
		throw new Error(`No tarball URL for ${spec}`);
	}

	// Download tarball
	const res = await fetch(tarballUrl);
	if (!res.ok) {
		throw new Error(`Failed to download tarball for ${spec}: ${res.status}`);
	}

	const buffer = await res.arrayBuffer();

	// Parse tar.gz with nanotar
	const files = await parseTarGzip(new Uint8Array(buffer));

	// Use abstract filesystem interface
	await fs.mkdir(destPath, { recursive: true });

	// Detect the tarball prefix - npm uses "package/" but DefinitelyTyped uses the package name
	// Find the common prefix by looking at the first file path
	let tarballPrefix = "package/";
	for (const file of files) {
		if (file.type === "file" && file.name.includes("/")) {
			const firstSegment = file.name.split("/")[0];
			tarballPrefix = `${firstSegment}/`;
			break;
		}
	}

	// Write files, stripping the detected prefix
	for (const file of files) {
		if (file.type === "file" && file.data) {
			// Strip the tarball prefix (e.g., "package/" or "react/" for @types/react)
			const relativePath = file.name.startsWith(tarballPrefix)
				? file.name.slice(tarballPrefix.length)
				: file.name;

			// Skip empty paths (happens if file.name was just the prefix)
			if (!relativePath) continue;

			const fullPath = join(destPath, relativePath);

			// Ensure parent directory exists
			await fs.mkdir(dirname(fullPath), { recursive: true });

			// Write the file
			await fs.writeFile(fullPath, file.data);
		}
	}

	return { integrity: manifest.integrity };
}

/**
 * Parse a package spec into name and version range
 * Examples:
 *   "lodash" -> { name: "lodash", versionRange: "latest" }
 *   "lodash@4" -> { name: "lodash", versionRange: "4" }
 *   "lodash@^4.17.0" -> { name: "lodash", versionRange: "^4.17.0" }
 *   "@types/node@18" -> { name: "@types/node", versionRange: "18" }
 */
export function parseSpec(spec: string): DependencySpec {
	// Handle scoped packages (@org/name)
	if (spec.startsWith("@")) {
		const match = spec.match(/^(@[^/]+\/[^@]+)(?:@(.+))?$/);
		if (match?.[1]) {
			return {
				name: match[1],
				versionRange: match[2] || "latest",
			};
		}
	}

	// Handle regular packages
	const atIndex = spec.lastIndexOf("@");
	if (atIndex > 0) {
		return {
			name: spec.slice(0, atIndex),
			versionRange: spec.slice(atIndex + 1),
		};
	}

	return {
		name: spec,
		versionRange: "latest",
	};
}

/**
 * Create a spec string from name and version
 */
export function createSpec(name: string, version: string): string {
	return `${name}@${version}`;
}

/**
 * Clear the packument cache (useful for testing)
 */
export function clearPackumentCache(): void {
	packumentCache.clear();
}
