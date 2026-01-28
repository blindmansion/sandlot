import type { ISharedModuleRegistry } from "../types";

/**
 * Generate a unique instance ID for a registry.
 * Uses crypto.randomUUID if available, otherwise falls back to a simple counter + timestamp.
 */
let instanceCounter = 0;
function generateInstanceId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().slice(0, 8);
  }
  // Fallback for environments without crypto.randomUUID
  return `${Date.now().toString(36)}_${(++instanceCounter).toString(36)}`;
}

/**
 * Simple shared module registry implementation.
 * Created internally by Sandlot from the sharedModules option.
 *
 * Each registry instance has a unique key (e.g., `__sandlot_abc123__`) that
 * isolates it from other Sandlot instances. This allows multiple Sandlot
 * instances to run concurrently with separate shared module configurations.
 *
 * The registry must be exposed globally for bundled code to access shared modules
 * at runtime. Call `exposeGlobally()` after creation, or use `createSharedModuleRegistry()`
 * which does this automatically.
 */
export class SharedModuleRegistry implements ISharedModuleRegistry {
  private modules: Map<string, unknown>;
  private exportNamesMap: Map<string, string[]>;
  private _registryKey: string;

  constructor(modules: Record<string, unknown>) {
    this._registryKey = `__sandlot_${generateInstanceId()}__`;
    this.modules = new Map(Object.entries(modules));
    this.exportNamesMap = new Map();

    // Introspect exports for each module
    for (const [id, mod] of this.modules) {
      this.exportNamesMap.set(id, this.introspectExports(mod));
    }
  }

  /**
   * The unique global key where this registry is exposed.
   * Bundled code accesses the registry via `globalThis[registryKey]`.
   */
  get registryKey(): string {
    return this._registryKey;
  }

  /**
   * Expose this registry globally so bundled code can access shared modules.
   * This sets globalThis[this.registryKey] = this.
   */
  exposeGlobally(): this {
    (globalThis as Record<string, unknown>)[this._registryKey] = this;
    return this;
  }

  /**
   * Remove this registry from global scope.
   */
  removeFromGlobal(): void {
    if ((globalThis as Record<string, unknown>)[this._registryKey] === this) {
      delete (globalThis as Record<string, unknown>)[this._registryKey];
    }
  }

  get(moduleId: string): unknown {
    const mod = this.modules.get(moduleId);
    if (mod === undefined && !this.modules.has(moduleId)) {
      throw new Error(`Shared module "${moduleId}" not registered.`);
    }
    return mod;
  }

  has(moduleId: string): boolean {
    return this.modules.has(moduleId);
  }

  getExportNames(moduleId: string): string[] {
    return this.exportNamesMap.get(moduleId) ?? [];
  }

  list(): string[] {
    return [...this.modules.keys()];
  }

  private introspectExports(module: unknown): string[] {
    if (module === null || module === undefined) {
      return [];
    }
    if (typeof module !== "object" && typeof module !== "function") {
      return [];
    }

    const exports: string[] = [];
    for (const key of Object.keys(module as object)) {
      if (this.isValidIdentifier(key)) {
        exports.push(key);
      }
    }
    return exports;
  }

  private isValidIdentifier(name: string): boolean {
    if (name.length === 0) return false;
    if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)) return false;
    const reserved = [
      "default",
      "class",
      "function",
      "var",
      "let",
      "const",
      "import",
      "export",
    ];
    return !reserved.includes(name);
  }
}

/**
 * Create a shared module registry from a modules object.
 * Automatically exposes the registry globally for bundled code to access.
 * Returns null if no modules are provided.
 */
export function createSharedModuleRegistry(
  modules?: Record<string, unknown>
): SharedModuleRegistry | null {
  if (!modules || Object.keys(modules).length === 0) {
    return null;
  }
  const registry = new SharedModuleRegistry(modules);
  registry.exposeGlobally();
  return registry;
}
