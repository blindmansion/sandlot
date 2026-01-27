/**
 * Sandlot Internal APIs
 *
 * These exports are for advanced use cases and may change without notice.
 * Import from 'sandlot/internal' only when the main API doesn't meet your needs.
 *
 * @module sandlot/internal
 */

// =============================================================================
// Module URL Management
// =============================================================================

/**
 * Create a blob URL for a bundle. Prefer `loadModule` from 'sandlot' instead.
 * Remember to call `revokeModuleUrl()` when done to free memory.
 */
export { createModuleUrl, revokeModuleUrl } from "./loader";

// =============================================================================
// Package Resolution Internals
// =============================================================================

/**
 * Parse a package specifier like "lodash@4.17.21" into name and version.
 */
export { parsePackageSpec } from "./packages";

/**
 * Resolve an import path to an esm.sh URL using installed package versions.
 */
export { resolveToEsmUrl } from "./packages";

/**
 * Parse an import path into package name and subpath.
 */
export { parseImportPath } from "./packages";

/**
 * In-memory cache for package types (DTS files from esm.sh).
 */
export { InMemoryTypesCache } from "./packages";

// =============================================================================
// TypeScript Library Internals
// =============================================================================

/**
 * Parse `/// <reference lib="..." />` directives from TypeScript source.
 */
export { parseLibReferences } from "./ts-libs";

/**
 * Convert a lib name (e.g., "ES2020") to its filename (e.g., "lib.es2020.d.ts").
 */
export { libNameToFileName } from "./ts-libs";

/**
 * Extract the lib name from a filename (e.g., "lib.es2020.d.ts" -> "ES2020").
 */
export { extractLibName } from "./ts-libs";

/**
 * Fetch a single TypeScript lib file from CDN.
 */
export { fetchLibFile } from "./ts-libs";

/**
 * Fetch multiple TypeScript lib files, resolving dependencies.
 */
export { fetchAllLibs } from "./ts-libs";

/**
 * Cache for TypeScript lib files.
 */
export { LibCache } from "./ts-libs";

// =============================================================================
// Shared Module Registry Internals
// =============================================================================

/**
 * The SharedModuleRegistry class. Prefer `registerSharedModules` from 'sandlot'.
 */
export { SharedModuleRegistry } from "./shared-modules";

/**
 * Get the global shared module registry instance.
 */
export { getSharedModuleRegistry } from "./shared-modules";

/**
 * Check if the global registry exists.
 */
export { hasSharedModuleRegistry } from "./shared-modules";

/**
 * Get the runtime code for accessing a shared module.
 */
export { getSharedModuleRuntimeCode } from "./shared-modules";

// =============================================================================
// Command Internals
// =============================================================================

/**
 * Format esbuild messages for display.
 */
export { formatEsbuildMessages } from "./commands";

// =============================================================================
// BuildEmitter (for custom build event handling)
// =============================================================================

/**
 * Build event emitter for sandbox environments.
 * Use this for custom build event handling in advanced use cases.
 */
export { BuildEmitter } from "./build-emitter";
