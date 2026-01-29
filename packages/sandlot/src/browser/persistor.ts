/**
 * IndexedDB-backed persistor for browsers.
 * Provides persistent caching across page reloads.
 */

import type { ICache, IPersistor } from "../core/persistor";
import type { ResolvedTypes } from "../core/esm-types-resolver";

// =============================================================================
// Configuration
// =============================================================================

const DB_NAME = "sandlot-cache";
const DB_VERSION = 1;

// =============================================================================
// IndexedDB Cache Implementation
// =============================================================================

/**
 * IndexedDB-backed cache implementation.
 * Provides persistent storage that survives page reloads.
 */
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

// =============================================================================
// IndexedDB Persistor
// =============================================================================

/**
 * IndexedDB-backed persistor for browsers.
 * Provides persistent caching across page reloads.
 *
 * @example
 * ```ts
 * import { createBrowserSandlot, createIndexedDBPersistor } from "sandlot/browser";
 *
 * const persistor = await createIndexedDBPersistor();
 * const sandlot = await createBrowserSandlot({
 *   persistor,
 *   sharedModules: { react: React },
 * });
 * ```
 */
export class IndexedDBPersistor implements IPersistor {
  readonly tsLibs: ICache<string>;
  readonly packageTypes: ICache<ResolvedTypes>;

  private constructor(db: IDBDatabase) {
    this.tsLibs = new IndexedDBCache<string>(db, "tsLibs");
    this.packageTypes = new IndexedDBCache<ResolvedTypes>(db, "packageTypes");
  }

  /**
   * Create an IndexedDBPersistor instance.
   * Opens (or creates) the IndexedDB database.
   */
  static async create(dbName = DB_NAME): Promise<IndexedDBPersistor> {
    const db = await openDatabase(dbName);
    return new IndexedDBPersistor(db);
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Open or create the IndexedDB database.
 */
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

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create an IndexedDB-backed persistor for persistent browser caching.
 *
 * @example
 * ```ts
 * const persistor = await createIndexedDBPersistor();
 * const sandlot = await createBrowserSandlot({ persistor });
 * ```
 */
export async function createIndexedDBPersistor(
  dbName = DB_NAME
): Promise<IPersistor> {
  return IndexedDBPersistor.create(dbName);
}
