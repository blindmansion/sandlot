# Unified Persistor for Sandlot

## Overview

This plan introduces a unified `IPersistor` abstraction to handle all caching in Sandlot. Currently, caching is scattered across components with different patterns. This refactor consolidates everything into a single, injectable interface.

## Goals

1. **Unified caching** - All deterministic resource caching goes through one abstraction
2. **Injectable** - Users can provide custom cache implementations (in-memory, IndexedDB, filesystem, etc.)
3. **Clean interfaces** - Remove the existing `ITypesCache` and `InMemoryTypesCache` in favor of a generic `ICache<T>`
4. **Simpler internals** - Typechecker and EsmTypesResolver both use the same cache pattern

## What Gets Cached

| Resource | Cache Key Format | Description |
|----------|-----------------|-------------|
| TypeScript lib files | `ts:${version}:${libName}` | e.g., `ts:5.9.3:dom` |
| Package type definitions | `types:${package}@${version}` | e.g., `types:lodash@4.17.21` |

## What Does NOT Go Through Persistor

| Component | Reason |
|-----------|--------|
| SharedModuleRegistry global | Runtime requirement for bundled code to access shared modules |
| esbuild instance | Service/process, not cached data |
| Filesystem state | Deferred for future implementation |

---

## Interface Design

### `ICache<T>` - Generic Cache Interface

```typescript
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
```

### `IPersistor` - Unified Cache Provider

```typescript
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
```

### `ResolvedTypes` - Package Types Data Structure

```typescript
/**
 * Resolved type definitions for a package.
 * This is the cached value for packageTypes.
 */
export interface ResolvedTypes {
  /** The package name (may differ from request if @types fallback was used) */
  packageName: string;
  /** The resolved version */
  version: string;
  /** Map of relative file paths to content (e.g., "index.d.ts" -> "...") */
  files: Record<string, string>;
  /** Whether types came from @types/* package */
  fromTypesPackage: boolean;
}
```

---

## Implementation

### New File: `core/persistor.ts`

```typescript
/**
 * Persistor - Unified cache provider for Sandlot.
 */

import type { ResolvedTypes } from "./esm-types-resolver";

// =============================================================================
// Cache Interface
// =============================================================================

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

export interface IPersistor {
  readonly tsLibs: ICache<string>;
  readonly packageTypes: ICache<ResolvedTypes>;
}

// =============================================================================
// In-Memory Implementation
// =============================================================================

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

export class InMemoryPersistor implements IPersistor {
  readonly tsLibs = new InMemoryCache<string>();
  readonly packageTypes = new InMemoryCache<ResolvedTypes>();
}

export function createInMemoryPersistor(): IPersistor {
  return new InMemoryPersistor();
}
```

### Changes to `core/typechecker.ts`

Remove the private `libCache` Map and accept an `ICache<string>` instead.

```typescript
export interface TypecheckerOptions {
  libs?: string[];
  libsBaseUrl?: string;
  
  /**
   * Cache for TypeScript lib files.
   * If not provided, an internal Map is used (no sharing across instances).
   */
  cache?: ICache<string>;
}

export class Typechecker implements ITypechecker {
  private options: TypecheckerOptions;
  private cache: ICache<string>;
  private initPromise: Promise<void> | null = null;

  constructor(options: TypecheckerOptions = {}) {
    this.options = options;
    // Use provided cache or create a simple in-memory one
    this.cache = options.cache ?? new InMemoryCache<string>();
  }
  
  // ... rest of implementation uses this.cache instead of this.libCache
}
```

### Changes to `core/esm-types-resolver.ts`

Remove the custom `ITypesCache` and `InMemoryTypesCache` classes. Use the generic `ICache<ResolvedTypes>` instead.

```typescript
export interface EsmTypesResolverOptions {
  baseUrl?: string;
  tryTypesPackages?: boolean;
  
  /**
   * Cache for resolved types.
   * If not provided, no caching is performed.
   */
  cache?: ICache<ResolvedTypes>;
}

export class EsmTypesResolver implements ITypesResolver {
  private baseUrl: string;
  private cache: ICache<ResolvedTypes> | null;
  private tryTypesPackages: boolean;

  constructor(options: EsmTypesResolverOptions = {}) {
    this.baseUrl = options.baseUrl ?? "https://esm.sh";
    this.cache = options.cache ?? null;
    this.tryTypesPackages = options.tryTypesPackages ?? true;
  }
  
  // ... cache usage stays the same, just with ICache<ResolvedTypes> type
}
```

### Changes to `types.ts`

Add persistor to SandlotOptions:

```typescript
export interface SandlotOptions {
  bundler: IBundler;
  executor?: IExecutor;
  typechecker?: ITypechecker;
  typesResolver?: ITypesResolver;
  sharedModules?: Record<string, unknown>;
  sandboxDefaults?: { maxFilesystemSize?: number };
  
  /**
   * Unified cache provider.
   * If provided, used to create typechecker and typesResolver with shared caching.
   * If typechecker/typesResolver are also provided, they take precedence.
   */
  persistor?: IPersistor;
}
```

### Changes to `core/sandlot.ts`

Wire up the persistor when creating internal components:

```typescript
export function createSandlot(options: SandlotOptions): Sandlot {
  const {
    bundler,
    typechecker: providedTypechecker,
    typesResolver: providedTypesResolver,
    executor,
    sharedModules,
    persistor,
    sandboxDefaults = {},
  } = options;

  // Use provided components, or create new ones with persistor caching
  const typechecker = providedTypechecker ?? (persistor 
    ? new Typechecker({ cache: persistor.tsLibs })
    : undefined
  );
  
  const typesResolver = providedTypesResolver ?? (persistor
    ? new EsmTypesResolver({ cache: persistor.packageTypes })
    : undefined
  );

  // ... rest of implementation
}
```

### Changes to `browser/preset.ts`

Update to use persistor:

```typescript
export interface BrowserSandlotOptions {
  bundler?: EsbuildWasmBundlerOptions;
  typechecker?: TypecheckerOptions;
  typesResolver?: EsmTypesResolverOptions;
  executor?: MainThreadExecutorOptions | IframeExecutorOptions;
  executorType?: "main-thread" | "iframe";
  sharedModules?: Record<string, unknown>;
  sandboxDefaults?: { maxFilesystemSize?: number };
  
  /**
   * Unified cache provider.
   * Defaults to InMemoryPersistor if not provided.
   */
  persistor?: IPersistor;
}

export async function createBrowserSandlot(
  options: BrowserSandlotOptions = {}
): Promise<Sandlot> {
  const persistor = options.persistor ?? createInMemoryPersistor();
  
  const bundler = new EsbuildWasmBundler(options.bundler);
  const typechecker = new Typechecker({ 
    cache: persistor.tsLibs,
    ...options.typechecker,
  });
  const typesResolver = new EsmTypesResolver({ 
    cache: persistor.packageTypes,
    ...options.typesResolver,
  });
  
  // ... rest of implementation
}
```

### Changes to `node/preset.ts`

Same pattern as browser preset.

### New File: `browser/persistor.ts` (Optional Enhancement)

IndexedDB-backed persistor for persistent browser caching:

```typescript
/**
 * IndexedDB-backed persistor for browsers.
 * Provides persistent caching across page reloads.
 */

const DB_NAME = "sandlot-cache";
const DB_VERSION = 1;

class IndexedDBCache<T> implements ICache<T> {
  constructor(
    private db: IDBDatabase,
    private storeName: string
  ) {}

  async get(key: string): Promise<T | null> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.storeName, "readonly");
      const store = tx.objectStore(this.storeName);
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result?.value ?? null);
      request.onerror = () => reject(request.error);
    });
  }

  async set(key: string, value: T): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      const request = store.put({ key, value });
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async has(key: string): Promise<boolean> {
    const value = await this.get(key);
    return value !== null;
  }

  async delete(key: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      const request = store.delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async clear(): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
}

export class IndexedDBPersistor implements IPersistor {
  readonly tsLibs: ICache<string>;
  readonly packageTypes: ICache<ResolvedTypes>;

  private constructor(db: IDBDatabase) {
    this.tsLibs = new IndexedDBCache<string>(db, "tsLibs");
    this.packageTypes = new IndexedDBCache<ResolvedTypes>(db, "packageTypes");
  }

  static async create(dbName = DB_NAME): Promise<IndexedDBPersistor> {
    const db = await openDatabase(dbName);
    return new IndexedDBPersistor(db);
  }
}

async function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DB_VERSION);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      
      // Create object stores with key as the index
      if (!db.objectStoreNames.contains("tsLibs")) {
        db.createObjectStore("tsLibs", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("packageTypes")) {
        db.createObjectStore("packageTypes", { keyPath: "key" });
      }
    };
  });
}

export async function createIndexedDBPersistor(): Promise<IPersistor> {
  return IndexedDBPersistor.create();
}
```

---

## Exports

### From `index.ts` (main entry)

```typescript
// Persistor
export { 
  InMemoryCache,
  InMemoryPersistor, 
  createInMemoryPersistor,
} from "./core/persistor";
export type { ICache, IPersistor } from "./core/persistor";

// ResolvedTypes moves to be exported from core (used by persistor)
export type { ResolvedTypes } from "./core/esm-types-resolver";
```

### From `browser/index.ts`

```typescript
// Browser-specific persistor
export { 
  IndexedDBPersistor,
  createIndexedDBPersistor,
} from "./persistor";
```

---

## Removals

1. **`ITypesCache`** from `esm-types-resolver.ts` - Replaced by `ICache<ResolvedTypes>`
2. **`InMemoryTypesCache`** from `esm-types-resolver.ts` - Replaced by `InMemoryCache<ResolvedTypes>`
3. **Private `libCache` Map** from `typechecker.ts` - Replaced by injectable `ICache<string>`

---

## Usage Examples

### Default (in-memory caching)

```typescript
import { createBrowserSandlot } from "sandlot/browser";

// InMemoryPersistor is created automatically
const sandlot = await createBrowserSandlot({
  sharedModules: { react: React },
});
```

### Persistent caching (IndexedDB)

```typescript
import { createBrowserSandlot, createIndexedDBPersistor } from "sandlot/browser";

const persistor = await createIndexedDBPersistor();
const sandlot = await createBrowserSandlot({
  persistor,
  sharedModules: { react: React },
});
```

### Custom persistor

```typescript
import { createBrowserSandlot, type IPersistor, InMemoryCache } from "sandlot/browser";

// Custom persistor that logs all cache operations
class LoggingPersistor implements IPersistor {
  readonly tsLibs = new LoggingCache<string>("tsLibs");
  readonly packageTypes = new LoggingCache<ResolvedTypes>("packageTypes");
}

const sandlot = await createBrowserSandlot({
  persistor: new LoggingPersistor(),
});
```

### Manual wiring (advanced)

```typescript
import { createSandlot, Typechecker, EsmTypesResolver, createInMemoryPersistor } from "sandlot";
import { EsbuildWasmBundler } from "sandlot/browser";

const persistor = createInMemoryPersistor();

const sandlot = createSandlot({
  bundler: new EsbuildWasmBundler(),
  typechecker: new Typechecker({ cache: persistor.tsLibs }),
  typesResolver: new EsmTypesResolver({ cache: persistor.packageTypes }),
  sharedModules: { react: React },
});
```

---

## Implementation Order

1. Create `core/persistor.ts` with `ICache`, `IPersistor`, and `InMemoryPersistor`
2. Update `core/typechecker.ts` to accept `cache` option
3. Update `core/esm-types-resolver.ts` to use `ICache<ResolvedTypes>` and remove old interfaces
4. Update `types.ts` to add `persistor` to `SandlotOptions`
5. Update `core/sandlot.ts` to wire up persistor
6. Update `browser/preset.ts` and `node/preset.ts` to use persistor
7. Update `index.ts` exports
8. Create `browser/persistor.ts` with `IndexedDBPersistor`
9. Update tests
10. Update examples

---

## Future: Filesystem Persistence

When we add filesystem persistence, it will be a new property on `IPersistor`:

```typescript
export interface IPersistor {
  readonly tsLibs: ICache<string>;
  readonly packageTypes: ICache<ResolvedTypes>;
  
  // Future
  readonly filesystems?: ICache<Record<string, string>>;
}
```

Key format would be `fs:${sandboxId}` with the full filesystem state as the value.
