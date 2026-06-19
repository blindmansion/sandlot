import type { BundleFileSystem } from "./bundle/fs";
import type { InstallFileSystem } from "./install/fs";
import type { TypecheckFileSystem } from "./typecheck/fs";

export type UnionFileSystem = InstallFileSystem & BundleFileSystem & TypecheckFileSystem;