/**
 * Sandbox fixture for integration tests
 *
 * Provides utilities for creating and managing sandboxes in tests.
 */

import { createNodeSandlot, type Sandlot, type Sandbox } from "sandlot/node";
import type { IPersistor } from "sandlot";
import { afterAll, beforeAll } from "bun:test";
import { createFsPersistor } from "./fs-persistor.ts";

export interface TestSandbox {
  sandlot: Sandlot;
  sandbox: Sandbox;
}

export interface CreateTestSandboxOptions {
  /** Shared modules to inject into the sandbox */
  sharedModules?: Record<string, unknown>;

  /**
   * Custom persistor for caching.
   * Defaults to a shared filesystem persistor at test/.cache/
   */
  persistor?: IPersistor;
}

/**
 * Shared filesystem persistor used by all tests.
 * This caches TypeScript libs and package types to disk, speeding up
 * repeated test runs by avoiding redundant network fetches.
 */
const defaultPersistor = createFsPersistor();

/**
 * Creates a sandlot and sandbox for testing.
 * Remember to call `sandlot.dispose()` when done.
 */
export async function createTestSandbox(
  options: CreateTestSandboxOptions = {}
): Promise<TestSandbox> {
  const sandlot = await createNodeSandlot({
    sharedModules: options.sharedModules,
    persistor: options.persistor ?? defaultPersistor,
  });
  const sandbox = await sandlot.createSandbox();
  return { sandlot, sandbox };
}

/**
 * Test helper that creates a sandbox before all tests and disposes it after.
 * Returns a getter function to access the sandbox in tests.
 *
 * @example
 * ```ts
 * const getSandbox = withSandbox();
 *
 * test("my test", async () => {
 *   const { sandbox } = getSandbox();
 *   // use sandbox...
 * });
 * ```
 */
export function withSandbox(
  options: CreateTestSandboxOptions = {}
): () => TestSandbox {
  let testSandbox: TestSandbox | null = null;

  beforeAll(async () => {
    testSandbox = await createTestSandbox(options);
  });

  afterAll(async () => {
    if (testSandbox) {
      await testSandbox.sandlot.dispose();
      testSandbox = null;
    }
  });

  return () => {
    if (!testSandbox) {
      throw new Error(
        "Sandbox not initialized. Make sure beforeAll has run."
      );
    }
    return testSandbox;
  };
}
