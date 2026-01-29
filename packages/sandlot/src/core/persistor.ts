/**
 * Persistor - Unified cache provider for Sandlot.
 *
 * This module provides a generic caching abstraction that can be used
 * by various components (typechecker, types resolver, etc.) with different
 * backend implementations (in-memory, IndexedDB, filesystem, etc.).
 */

import type { ResolvedTypes } from "./esm-types-resolver";

// =============================================================================
// Cache Interface
// =============================================================================

/**
 * Generic async cache interface.
 * All cache operations are async to support both sync (Map) and async (IndexedDB) backends.
 */
export interface ICache<T> {
  get(key: string): Promise<T | null>;
  set(key: string, value: T): Promise<void>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

// =============================================================================
// Persistor Interface
// =============================================================================

/**
 * Unified cache provider for Sandlot.
 *
 * Provides typed caches for different resource types.
 * All caches use the generic ICache<T> interface.
 */
export interface IPersistor {
  /**
   * Cache for TypeScript lib files (lib.dom.d.ts, lib.es2020.d.ts, etc.)
   *
   * Key format: `ts:${version}:${libName}`
   * Example: `ts:5.9.3:dom`
   *
   * Value: The .d.ts file content as a string
   */
  readonly tsLibs: ICache<string>;

  /**
   * Cache for npm package type definitions.
   *
   * Key format: `types:${package}@${version}`
   * Example: `types:lodash@4.17.21`
   *
   * Value: ResolvedTypes object containing all .d.ts files for the package
   */
  readonly packageTypes: ICache<ResolvedTypes>;
}

// =============================================================================
// In-Memory Implementation
// =============================================================================

/**
 * Simple in-memory cache implementation using a Map.
 * Works on all platforms (browser, Node.js, Bun, Deno).
 */
export class InMemoryCache<T> implements ICache<T> {
  private cache = new Map<string, T>();

  async get(key: string): Promise<T | null> {
    return this.cache.get(key) ?? null;
  }

  async set(key: string, value: T): Promise<void> {
    this.cache.set(key, value);
  }

  async has(key: string): Promise<boolean> {
    return this.cache.has(key);
  }

  async delete(key: string): Promise<void> {
    this.cache.delete(key);
  }

  async clear(): Promise<void> {
    this.cache.clear();
  }
}

/**
 * In-memory persistor implementation.
 * Suitable for single-session usage where persistence across reloads is not needed.
 */
export class InMemoryPersistor implements IPersistor {
  readonly tsLibs = new InMemoryCache<string>();
  readonly packageTypes = new InMemoryCache<ResolvedTypes>();
}

/**
 * Create an in-memory persistor instance.
 */
export function createInMemoryPersistor(): IPersistor {
  return new InMemoryPersistor();
}
