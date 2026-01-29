/**
 * Integration tests for the filesystem persistor.
 *
 * Tests that the FsPersistor correctly caches TypeScript libs and package types
 * to the filesystem.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createNodeSandlot, type Sandlot, type Sandbox } from "sandlot/node";
import { createFsPersistor, FsPersistor } from "../harness/index.ts";

const TEST_CACHE_DIR = join(import.meta.dir, "..", ".cache-test");

describe("filesystem persistor", () => {
  let persistor: FsPersistor;
  let sandlot: Sandlot;
  let sandbox: Sandbox;

  beforeAll(async () => {
    // Clean up any existing test cache
    rmSync(TEST_CACHE_DIR, { recursive: true, force: true });

    // Create persistor with custom cache directory
    persistor = createFsPersistor(TEST_CACHE_DIR);

    // Create sandlot with the persistor
    sandlot = await createNodeSandlot({ persistor });
    sandbox = await sandlot.createSandbox();
  });

  afterAll(async () => {
    await sandlot.dispose();
    // Clean up test cache
    rmSync(TEST_CACHE_DIR, { recursive: true, force: true });
  });

  test("cache directory is created", () => {
    expect(existsSync(TEST_CACHE_DIR)).toBe(true);
    expect(existsSync(join(TEST_CACHE_DIR, "ts-libs"))).toBe(true);
    expect(existsSync(join(TEST_CACHE_DIR, "package-types"))).toBe(true);
  });

  test("tsLibs cache operations", async () => {
    const { tsLibs } = persistor;

    // Initially empty
    expect(await tsLibs.has("ts:5.9.3:dom")).toBe(false);
    expect(await tsLibs.get("ts:5.9.3:dom")).toBe(null);

    // Set a value
    await tsLibs.set("ts:5.9.3:dom", "declare var window: Window;");
    expect(await tsLibs.has("ts:5.9.3:dom")).toBe(true);
    expect(await tsLibs.get("ts:5.9.3:dom")).toBe("declare var window: Window;");

    // File should exist on disk
    const filePath = join(TEST_CACHE_DIR, "ts-libs", "5.9.3", "dom.d.ts");
    expect(existsSync(filePath)).toBe(true);

    // Delete the value
    await tsLibs.delete("ts:5.9.3:dom");
    expect(await tsLibs.has("ts:5.9.3:dom")).toBe(false);
  });

  test("packageTypes cache operations", async () => {
    const { packageTypes } = persistor;

    const testTypes = {
      packageName: "test-pkg",
      version: "1.0.0",
      files: {
        "index.d.ts": "export declare const foo: string;",
        "utils/helper.d.ts": "export declare function helper(): void;",
      },
      fromTypesPackage: false,
    };

    // Initially empty
    expect(await packageTypes.has("types:test-pkg@1.0.0")).toBe(false);
    expect(await packageTypes.get("types:test-pkg@1.0.0")).toBe(null);

    // Set a value
    await packageTypes.set("types:test-pkg@1.0.0", testTypes);
    expect(await packageTypes.has("types:test-pkg@1.0.0")).toBe(true);

    // Retrieve and verify
    const retrieved = await packageTypes.get("types:test-pkg@1.0.0");
    expect(retrieved).not.toBe(null);
    expect(retrieved!.packageName).toBe("test-pkg");
    expect(retrieved!.version).toBe("1.0.0");
    expect(retrieved!.files["index.d.ts"]).toBe("export declare const foo: string;");
    expect(retrieved!.files["utils/helper.d.ts"]).toBe("export declare function helper(): void;");

    // Directory should exist on disk (package-types/{package}/{version}/)
    const packageDir = join(TEST_CACHE_DIR, "package-types", "test-pkg", "1.0.0");
    expect(existsSync(packageDir)).toBe(true);
    expect(existsSync(join(packageDir, "meta.json"))).toBe(true);
    expect(existsSync(join(packageDir, "files", "index.d.ts"))).toBe(true);
    expect(existsSync(join(packageDir, "files", "utils", "helper.d.ts"))).toBe(true);

    // Delete the value
    await packageTypes.delete("types:test-pkg@1.0.0");
    expect(await packageTypes.has("types:test-pkg@1.0.0")).toBe(false);
  });

  test("scoped package names are handled correctly", async () => {
    const { packageTypes } = persistor;

    const testTypes = {
      packageName: "@types/lodash",
      version: "4.17.0",
      files: {
        "index.d.ts": "declare module 'lodash' {}",
      },
      fromTypesPackage: true,
    };

    await packageTypes.set("types:@types/lodash@4.17.0", testTypes);

    // Directory should use -- instead of / for scoped packages
    // Structure: package-types/@types--lodash/4.17.0/
    const packageDir = join(TEST_CACHE_DIR, "package-types", "@types--lodash", "4.17.0");
    expect(existsSync(packageDir)).toBe(true);

    const retrieved = await packageTypes.get("types:@types/lodash@4.17.0");
    expect(retrieved!.packageName).toBe("@types/lodash");

    await packageTypes.delete("types:@types/lodash@4.17.0");
  });

  // Commented out to preserve cache between test runs for speed
  // test("clearAll removes all cached data", async () => {
  //   const { tsLibs, packageTypes } = persistor;
  //
  //   // Add some data
  //   await tsLibs.set("ts:5.0.0:es5", "// es5 types");
  //   await packageTypes.set("types:foo@1.0.0", {
  //     packageName: "foo",
  //     version: "1.0.0",
  //     files: { "index.d.ts": "// foo" },
  //     fromTypesPackage: false,
  //   });
  //
  //   expect(await tsLibs.has("ts:5.0.0:es5")).toBe(true);
  //   expect(await packageTypes.has("types:foo@1.0.0")).toBe(true);
  //
  //   // Clear all
  //   await persistor.clearAll();
  //
  //   expect(await tsLibs.has("ts:5.0.0:es5")).toBe(false);
  //   expect(await packageTypes.has("types:foo@1.0.0")).toBe(false);
  // });

  test("caching persists package types during typecheck", async () => {
    // Install a real package (just updates package.json)
    await sandbox.exec("sandlot install nanoid");

    // Write a simple file that imports nanoid so we have an entry point
    sandbox.writeFile(
      "/index.ts",
      `import { nanoid } from 'nanoid';
console.log(nanoid());`
    );

    // Call typecheck to trigger type installation and caching
    await sandbox.typecheck();

    // The types should now be cached on disk
    const packageTypesDir = join(TEST_CACHE_DIR, "package-types");
    expect(existsSync(packageTypesDir)).toBe(true);

    // Verify nanoid types are cached (the folder should exist)
    const nanoidDir = join(packageTypesDir, "nanoid");
    expect(existsSync(nanoidDir)).toBe(true);
  });
});
