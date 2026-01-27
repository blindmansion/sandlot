/**
 * Shared Module Registry for Sandlot
 * 
 * Allows host applications to register their module instances (like React)
 * so that dynamically bundled code can use the same instances instead of
 * loading separate copies from esm.sh CDN.
 * 
 * This solves the "multiple React instances" problem where hooks fail
 * because the host and dynamic code use different React copies.
 * 
 * @example
 * ```ts
 * // Host application setup
 * import * as React from 'react';
 * import * as ReactDOM from 'react-dom/client';
 * import { registerSharedModules } from 'sandlot';
 * 
 * registerSharedModules({
 *   'react': React,
 *   'react-dom/client': ReactDOM,
 * });
 * 
 * // Now create sandbox with sharedModules option
 * const sandbox = await createSandbox({
 *   sharedModules: ['react', 'react-dom/client'],
 * });
 * ```
 */

/**
 * Global key used to expose the registry for dynamic bundles
 */
const GLOBAL_KEY = '__sandlot_shared_modules__';

/**
 * Registry for sharing host modules with dynamic bundles.
 * Modules registered here will be used instead of esm.sh CDN
 * when the sandbox is configured with matching sharedModules.
 */
export class SharedModuleRegistry {
  private modules = new Map<string, unknown>();
  private exportNames = new Map<string, string[]>();

  constructor() {
    // Make available globally for dynamic imports
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = this;
  }

  /**
   * Register a module to be shared with dynamic bundles.
   * Automatically introspects the module to discover its exports.
   * 
   * @param moduleId - The import specifier (e.g., 'react', 'react-dom/client')
   * @param module - The module's exports object
   * @returns this for chaining
   */
  register(moduleId: string, module: unknown): this {
    this.modules.set(moduleId, module);
    // Introspect the module to get its export names
    this.exportNames.set(moduleId, introspectExports(module));
    return this;
  }

  /**
   * Register multiple modules at once.
   * Automatically introspects each module to discover its exports.
   * 
   * @param modules - Object mapping module IDs to their exports
   * @returns this for chaining
   */
  registerAll(modules: Record<string, unknown>): this {
    for (const [id, mod] of Object.entries(modules)) {
      this.register(id, mod);
    }
    return this;
  }

  /**
   * Unregister a previously registered module
   * 
   * @param moduleId - The import specifier to remove
   * @returns true if the module was registered and removed
   */
  unregister(moduleId: string): boolean {
    return this.modules.delete(moduleId);
  }

  /**
   * Get a registered module (used by dynamic bundles at runtime)
   * 
   * @param moduleId - The import specifier
   * @returns The registered module exports
   * @throws Error if the module is not registered
   */
  get(moduleId: string): unknown {
    const mod = this.modules.get(moduleId);
    if (mod === undefined && !this.modules.has(moduleId)) {
      const available = this.list();
      throw new Error(
        `Shared module "${moduleId}" not registered. ` +
        `Available: ${available.length > 0 ? available.join(', ') : '(none)'}. ` +
        `Call registerSharedModules({ '${moduleId}': ... }) in your host application.`
      );
    }
    return mod;
  }

  /**
   * Check if a module is registered
   * 
   * @param moduleId - The import specifier to check
   */
  has(moduleId: string): boolean {
    return this.modules.has(moduleId);
  }

  /**
   * Get list of all registered module IDs
   */
  list(): string[] {
    return [...this.modules.keys()];
  }

  /**
   * Get the export names for a registered module.
   * These were discovered by introspecting the module at registration time.
   * 
   * @param moduleId - The import specifier
   * @returns Array of export names, or empty array if not registered
   */
  getExportNames(moduleId: string): string[] {
    return this.exportNames.get(moduleId) ?? [];
  }

  /**
   * Clear all registrations
   */
  clear(): void {
    this.modules.clear();
    this.exportNames.clear();
  }

  /**
   * Get the number of registered modules
   */
  get size(): number {
    return this.modules.size;
  }
}

/**
 * Introspect a module to discover its export names.
 * Filters out non-identifier keys and internal properties.
 */
function introspectExports(module: unknown): string[] {
  if (module === null || module === undefined) {
    return [];
  }

  if (typeof module !== 'object' && typeof module !== 'function') {
    return [];
  }

  const exports: string[] = [];
  
  // Get own enumerable properties
  for (const key of Object.keys(module as object)) {
    // Filter out non-valid JavaScript identifiers
    if (isValidIdentifier(key)) {
      exports.push(key);
    }
  }

  return exports;
}

/**
 * Check if a string is a valid JavaScript identifier.
 * Used to filter out keys that can't be used as named exports.
 */
function isValidIdentifier(name: string): boolean {
  if (name.length === 0) return false;
  // Must start with letter, underscore, or $
  if (!/^[a-zA-Z_$]/.test(name)) return false;
  // Rest must be alphanumeric, underscore, or $
  if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)) return false;
  // Exclude reserved words that would cause issues
  const reserved = ['default', 'class', 'function', 'var', 'let', 'const', 'import', 'export'];
  if (reserved.includes(name)) return false;
  return true;
}

// Singleton instance
let defaultRegistry: SharedModuleRegistry | null = null;

/**
 * Get the default shared module registry.
 * Creates it if it doesn't exist.
 */
export function getSharedModuleRegistry(): SharedModuleRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new SharedModuleRegistry();
  }
  return defaultRegistry;
}

/**
 * Check if a shared module registry exists on globalThis
 */
export function hasSharedModuleRegistry(): boolean {
  return GLOBAL_KEY in globalThis;
}

/**
 * Convenience function to register modules with the default registry.
 * 
 * @param modules - Object mapping module IDs to their exports
 * 
 * @example
 * ```ts
 * import * as React from 'react';
 * import * as ReactDOM from 'react-dom/client';
 * import { registerSharedModules } from 'sandlot';
 * 
 * registerSharedModules({
 *   'react': React,
 *   'react-dom/client': ReactDOM,
 * });
 * ```
 */
export function registerSharedModules(modules: Record<string, unknown>): void {
  getSharedModuleRegistry().registerAll(modules);
}

/**
 * Convenience function to unregister a module from the default registry.
 * 
 * @param moduleId - The import specifier to remove
 * @returns true if the module was registered and removed
 */
export function unregisterSharedModule(moduleId: string): boolean {
  return getSharedModuleRegistry().unregister(moduleId);
}

/**
 * Clear all shared modules from the default registry.
 */
export function clearSharedModules(): void {
  getSharedModuleRegistry().clear();
}

/**
 * Get the export names for a registered shared module.
 * Used by the bundler to generate proper re-export statements.
 * 
 * @param moduleId - The import specifier
 * @returns Array of export names, or empty array if not registered
 */
export function getSharedModuleExports(moduleId: string): string[] {
  return getSharedModuleRegistry().getExportNames(moduleId);
}

/**
 * Generate the runtime code that dynamic bundles use to access shared modules.
 * This is injected into bundles when they import from shared modules.
 */
export function getSharedModuleRuntimeCode(moduleId: string): string {
  return `
(function() {
  var registry = globalThis["${GLOBAL_KEY}"];
  if (!registry) {
    throw new Error(
      'Sandlot SharedModuleRegistry not found. ' +
      'Call registerSharedModules() in your host application before loading dynamic modules.'
    );
  }
  return registry.get(${JSON.stringify(moduleId)});
})()
`.trim();
}
