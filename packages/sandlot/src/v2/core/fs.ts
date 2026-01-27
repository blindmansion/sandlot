import type {
  FsEntry,
  FsStat,
  MkdirOptions,
  RmOptions,
  CpOptions,
  FileContent,
  InitialFiles,
  FileInit,
  IFileSystem,
} from "just-bash/browser";

/**
 * Supported buffer encodings (matches just-bash)
 */
type BufferEncoding = "utf8" | "utf-8" | "ascii" | "binary" | "base64" | "hex" | "latin1";

/**
 * Options for reading files (matches just-bash)
 */
interface ReadFileOptions {
  encoding?: BufferEncoding | null;
}

/**
 * Options for writing files (matches just-bash)
 */
interface WriteFileOptions {
  encoding?: BufferEncoding;
}

/**
 * Directory entry with type information (matches just-bash DirentEntry)
 */
interface DirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

const DEFAULT_FILE_MODE = 0o644;
const DEFAULT_DIR_MODE = 0o755;
const DEFAULT_SYMLINK_MODE = 0o777;
const DEFAULT_MAX_SIZE_BYTES = 50 * 1024 * 1024; // 50MB default limit

/**
 * Options for creating a Filesystem instance
 */
export interface FilesystemOptions {
  /** Maximum total size in bytes (default: 50MB) */
  maxSizeBytes?: number;
  /** Initial files to populate */
  initialFiles?: InitialFiles;
}

/**
 * In-memory virtual filesystem for sandlot sandboxes.
 * 
 * All operations are synchronous in-memory. Use `getFiles()` to export
 * the current state for persistence, and `initialFiles` to restore.
 * 
 * @example
 * ```ts
 * // Create filesystem
 * const fs = Filesystem.create({ initialFiles: { '/src/index.ts': 'export const x = 1;' } });
 * 
 * // Use filesystem
 * fs.writeFile('/src/app.ts', 'console.log("hello")');
 * 
 * // Export for persistence
 * const files = fs.getFiles();
 * localStorage.setItem('my-project', JSON.stringify(files));
 * 
 * // Later, restore
 * const saved = JSON.parse(localStorage.getItem('my-project'));
 * const fs2 = Filesystem.create({ initialFiles: saved });
 * ```
 */
export class Filesystem {
  private entries: Map<string, FsEntry>;
  private maxSizeBytes: number;

  private constructor(
    entries: Map<string, FsEntry>,
    maxSizeBytes: number
  ) {
    this.entries = entries;
    this.maxSizeBytes = maxSizeBytes;
  }

  /**
   * Create a new Filesystem instance
   */
  static create(options: FilesystemOptions = {}): Filesystem {
    const maxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
    const entries = new Map<string, FsEntry>();

    // Always ensure root exists
    entries.set("/", {
      type: "directory",
      mode: DEFAULT_DIR_MODE,
      mtime: new Date(),
    });

    if (options.initialFiles) {
      for (const [path, value] of Object.entries(options.initialFiles)) {
        const normalizedPath = Filesystem.normalizePath(path);
        const init = Filesystem.parseFileInit(value);

        // Ensure parent directories exist
        Filesystem.ensureParentDirs(entries, normalizedPath);

        entries.set(normalizedPath, {
          type: "file",
          content: init.content,
          mode: init.mode ?? DEFAULT_FILE_MODE,
          mtime: init.mtime ?? new Date(),
        });
      }
    }

    return new Filesystem(entries, maxSizeBytes);
  }

  // ============ State Export ============

  /**
   * Get all files as a serializable object.
   * 
   * Returns a Record<string, string> that can be JSON-serialized and
   * used as `initialFiles` when creating a new filesystem.
   * 
   * Note: Only includes files, not directories (directories are
   * automatically created from file paths). Binary files are 
   * base64-encoded with a `data:` prefix.
   * 
   * @example
   * ```ts
   * const files = fs.getFiles();
   * // { '/src/index.ts': 'export const x = 1;', '/package.json': '{"name":"app"}' }
   * 
   * // Persist however you want
   * localStorage.setItem('project', JSON.stringify(files));
   * 
   * // Restore later
   * const saved = JSON.parse(localStorage.getItem('project'));
   * const fs2 = Filesystem.create({ initialFiles: saved });
   * ```
   */
  getFiles(): Record<string, string> {
    const files: Record<string, string> = {};

    for (const [path, entry] of this.entries) {
      if (entry.type === "file") {
        if (typeof entry.content === "string") {
          files[path] = entry.content;
        } else {
          // Binary content - base64 encode with data URI prefix
          const base64 = this.encodeBase64(entry.content);
          files[path] = `data:application/octet-stream;base64,${base64}`;
        }
      }
    }

    return files;
  }

  /**
   * Get approximate size of all stored data in bytes
   */
  getSize(): number {
    let size = 0;
    for (const [path, entry] of this.entries) {
      size += path.length * 2; // UTF-16
      if (entry.type === "file") {
        if (typeof entry.content === "string") {
          size += entry.content.length * 2;
        } else {
          size += entry.content.byteLength;
        }
      }
    }
    return size;
  }

  // ============ IFileSystem Implementation ============

  readFile(
    path: string,
    options?: ReadFileOptions | BufferEncoding
  ): string {
    const normalizedPath = this.normalizePath(path);
    const entry = this.resolveSymlinks(normalizedPath);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }
    if (entry.type !== "file") {
      throw new Error(`EISDIR: illegal operation on a directory, read '${path}'`);
    }

    const content = entry.content;
    if (typeof content === "string") {
      return content;
    }

    // Convert Uint8Array to string
    const encoding = this.getEncoding(options) ?? "utf8";
    return this.decodeBuffer(content, encoding);
  }

  readFileBuffer(path: string): Uint8Array {
    const normalizedPath = this.normalizePath(path);
    const entry = this.resolveSymlinks(normalizedPath);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }
    if (entry.type !== "file") {
      throw new Error(`EISDIR: illegal operation on a directory, read '${path}'`);
    }

    const content = entry.content;
    if (content instanceof Uint8Array) {
      return content;
    }

    // Convert string to Uint8Array
    return new TextEncoder().encode(content);
  }

  writeFile(
    path: string,
    content: FileContent,
    _options?: WriteFileOptions | BufferEncoding
  ): void {
    const normalizedPath = this.normalizePath(path);
    this.checkSizeLimit(content);
    this.ensureParentDirs(normalizedPath);

    const existing = this.entries.get(normalizedPath);
    if (existing && existing.type === "directory") {
      throw new Error(`EISDIR: illegal operation on a directory, open '${path}'`);
    }

    this.entries.set(normalizedPath, {
      type: "file",
      content,
      mode: existing?.mode ?? DEFAULT_FILE_MODE,
      mtime: new Date(),
    });
  }

  appendFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding
  ): void {
    const normalizedPath = this.normalizePath(path);
    let existing: string | Uint8Array = "";

    try {
      existing = this.readFile(normalizedPath);
    } catch {
      // File doesn't exist, will be created
    }

    const newContent =
      typeof existing === "string" && typeof content === "string"
        ? existing + content
        : this.concatBuffers(
          typeof existing === "string" ? new TextEncoder().encode(existing) : existing,
          typeof content === "string" ? new TextEncoder().encode(content) : content
        );

    this.writeFile(normalizedPath, newContent, options);
  }

  exists(path: string): boolean {
    const normalizedPath = this.normalizePath(path);
    return this.entries.has(normalizedPath);
  }

  stat(path: string): FsStat {
    const normalizedPath = this.normalizePath(path);
    const entry = this.resolveSymlinks(normalizedPath);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
    }

    return this.entryToStat(entry);
  }

  lstat(path: string): FsStat {
    const normalizedPath = this.normalizePath(path);
    const entry = this.entries.get(normalizedPath);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, lstat '${path}'`);
    }

    return this.entryToStat(entry);
  }

  mkdir(path: string, options?: MkdirOptions): void {
    const normalizedPath = this.normalizePath(path);

    if (this.entries.has(normalizedPath)) {
      if (options?.recursive) {
        return; // Already exists, ok with recursive
      }
      throw new Error(`EEXIST: file already exists, mkdir '${path}'`);
    }

    if (options?.recursive) {
      this.ensureParentDirs(normalizedPath);
    } else {
      const parent = this.getParentPath(normalizedPath);
      if (parent && !this.entries.has(parent)) {
        throw new Error(`ENOENT: no such file or directory, mkdir '${path}'`);
      }
    }

    this.entries.set(normalizedPath, {
      type: "directory",
      mode: DEFAULT_DIR_MODE,
      mtime: new Date(),
    });
  }

  readdir(path: string): string[] {
    const normalizedPath = this.normalizePath(path);
    const entry = this.resolveSymlinks(normalizedPath);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
    }
    if (entry.type !== "directory") {
      throw new Error(`ENOTDIR: not a directory, scandir '${path}'`);
    }

    const prefix = normalizedPath === "/" ? "/" : normalizedPath + "/";
    const names: string[] = [];

    for (const entryPath of this.entries.keys()) {
      if (entryPath === normalizedPath) continue;
      if (!entryPath.startsWith(prefix)) continue;

      const relative = entryPath.slice(prefix.length);
      if (!relative.includes("/")) {
        names.push(relative);
      }
    }

    return names.sort();
  }

  readdirWithFileTypes(path: string): DirentEntry[] {
    const normalizedPath = this.normalizePath(path);
    const entry = this.resolveSymlinks(normalizedPath);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
    }
    if (entry.type !== "directory") {
      throw new Error(`ENOTDIR: not a directory, scandir '${path}'`);
    }

    const prefix = normalizedPath === "/" ? "/" : normalizedPath + "/";
    const dirents: DirentEntry[] = [];

    for (const [entryPath, e] of this.entries) {
      if (entryPath === normalizedPath) continue;
      if (!entryPath.startsWith(prefix)) continue;

      const relative = entryPath.slice(prefix.length);
      if (!relative.includes("/")) {
        dirents.push({
          name: relative,
          isFile: e.type === "file",
          isDirectory: e.type === "directory",
          isSymbolicLink: e.type === "symlink",
        });
      }
    }

    return dirents.sort((a, b) => a.name.localeCompare(b.name));
  }

  rm(path: string, options?: RmOptions): void {
    const normalizedPath = this.normalizePath(path);
    const entry = this.entries.get(normalizedPath);

    if (!entry) {
      if (options?.force) return;
      throw new Error(`ENOENT: no such file or directory, rm '${path}'`);
    }

    if (entry.type === "directory") {
      const children = this.readdir(normalizedPath);
      if (children.length > 0 && !options?.recursive) {
        throw new Error(`ENOTEMPTY: directory not empty, rm '${path}'`);
      }

      if (options?.recursive) {
        // Delete all children
        const prefix = normalizedPath === "/" ? "/" : normalizedPath + "/";
        for (const entryPath of [...this.entries.keys()]) {
          if (entryPath.startsWith(prefix)) {
            this.entries.delete(entryPath);
          }
        }
      }
    }

    this.entries.delete(normalizedPath);
  }

  cp(src: string, dest: string, options?: CpOptions): void {
    const srcPath = this.normalizePath(src);
    const destPath = this.normalizePath(dest);
    const entry = this.entries.get(srcPath);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, cp '${src}'`);
    }

    if (entry.type === "directory") {
      if (!options?.recursive) {
        throw new Error(`EISDIR: cp called on directory without recursive '${src}'`);
      }

      // Copy directory and all children
      this.ensureParentDirs(destPath);
      this.entries.set(destPath, { ...entry, mtime: new Date() });

      const prefix = srcPath === "/" ? "/" : srcPath + "/";
      for (const [entryPath, e] of this.entries) {
        if (entryPath.startsWith(prefix)) {
          const relative = entryPath.slice(srcPath.length);
          const newPath = destPath + relative;
          this.entries.set(newPath, this.cloneEntry(e));
        }
      }
    } else {
      this.ensureParentDirs(destPath);
      this.entries.set(destPath, this.cloneEntry(entry));
    }
  }

  mv(src: string, dest: string): void {
    const srcPath = this.normalizePath(src);
    const destPath = this.normalizePath(dest);
    const entry = this.entries.get(srcPath);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, mv '${src}'`);
    }

    this.ensureParentDirs(destPath);

    if (entry.type === "directory") {
      // Move directory and all children
      const prefix = srcPath === "/" ? "/" : srcPath + "/";
      const toMove: [string, FsEntry][] = [];

      for (const [entryPath, e] of this.entries) {
        if (entryPath === srcPath || entryPath.startsWith(prefix)) {
          const relative = entryPath.slice(srcPath.length);
          toMove.push([destPath + relative, e]);
          this.entries.delete(entryPath);
        }
      }

      for (const [newPath, e] of toMove) {
        this.entries.set(newPath, e);
      }
    } else {
      this.entries.delete(srcPath);
      this.entries.set(destPath, entry);
    }
  }

  resolvePath(base: string, path: string): string {
    if (path.startsWith("/")) {
      return this.normalizePath(path);
    }

    const baseParts = base.split("/").filter(Boolean);
    const pathParts = path.split("/").filter(Boolean);

    for (const part of pathParts) {
      if (part === ".") {
        continue;
      } else if (part === "..") {
        baseParts.pop();
      } else {
        baseParts.push(part);
      }
    }

    return "/" + baseParts.join("/");
  }

  getAllPaths(): string[] {
    return [...this.entries.keys()].sort();
  }

  chmod(path: string, mode: number): void {
    const normalizedPath = this.normalizePath(path);
    const entry = this.entries.get(normalizedPath);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, chmod '${path}'`);
    }

    entry.mode = mode;
    entry.mtime = new Date();
  }

  symlink(target: string, linkPath: string): void {
    const normalizedLinkPath = this.normalizePath(linkPath);

    if (this.entries.has(normalizedLinkPath)) {
      throw new Error(`EEXIST: file already exists, symlink '${linkPath}'`);
    }

    this.ensureParentDirs(normalizedLinkPath);

    this.entries.set(normalizedLinkPath, {
      type: "symlink",
      target,
      mode: DEFAULT_SYMLINK_MODE,
      mtime: new Date(),
    });
  }

  link(existingPath: string, newPath: string): void {
    const srcPath = this.normalizePath(existingPath);
    const destPath = this.normalizePath(newPath);

    const entry = this.entries.get(srcPath);
    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, link '${existingPath}'`);
    }
    if (entry.type !== "file") {
      throw new Error(`EPERM: operation not permitted, link '${existingPath}'`);
    }
    if (this.entries.has(destPath)) {
      throw new Error(`EEXIST: file already exists, link '${newPath}'`);
    }

    this.ensureParentDirs(destPath);

    // Hard links share the same content reference
    this.entries.set(destPath, {
      type: "file",
      content: entry.content,
      mode: entry.mode,
      mtime: new Date(),
    });
  }

  readlink(path: string): string {
    const normalizedPath = this.normalizePath(path);
    const entry = this.entries.get(normalizedPath);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, readlink '${path}'`);
    }
    if (entry.type !== "symlink") {
      throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
    }

    return entry.target;
  }

  realpath(path: string): string {
    const normalizedPath = this.normalizePath(path);
    const parts = normalizedPath.split("/").filter(Boolean);
    let resolved = "/";

    for (const part of parts) {
      // Build the next path component
      resolved = resolved === "/" ? `/${part}` : `${resolved}/${part}`;

      // Check if this path component exists
      const entry = this.entries.get(resolved);
      if (!entry) {
        throw new Error(`ENOENT: no such file or directory, realpath '${path}'`);
      }

      // If it's a symlink, resolve it
      if (entry.type === "symlink") {
        const target = entry.target;
        // If target is absolute, use it; otherwise resolve relative to parent
        if (target.startsWith("/")) {
          resolved = this.normalizePath(target);
        } else {
          const parent = this.getParentPath(resolved) ?? "/";
          resolved = this.resolvePath(parent, target);
        }

        // Verify the resolved target exists
        const targetEntry = this.entries.get(resolved);
        if (!targetEntry) {
          throw new Error(`ENOENT: no such file or directory, realpath '${path}'`);
        }
      }
    }

    return resolved;
  }

  utimes(path: string, atime: Date, mtime: Date): void {
    const normalizedPath = this.normalizePath(path);
    const entry = this.entries.get(normalizedPath);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, utimes '${path}'`);
    }

    // Update mtime (atime is ignored as per interface docs, kept for API compatibility)
    entry.mtime = mtime;
  }

  // ============ Private Helpers ============

  private normalizePath(path: string): string {
    return Filesystem.normalizePath(path);
  }

  private static normalizePath(path: string): string {
    // Handle empty or relative paths
    if (!path || path === ".") return "/";
    if (!path.startsWith("/")) {
      path = "/" + path;
    }

    const parts = path.split("/").filter(Boolean);
    const normalized: string[] = [];

    for (const part of parts) {
      if (part === ".") continue;
      if (part === "..") {
        normalized.pop();
      } else {
        normalized.push(part);
      }
    }

    return "/" + normalized.join("/");
  }

  private getParentPath(path: string): string | null {
    if (path === "/") return null;
    const lastSlash = path.lastIndexOf("/");
    return lastSlash === 0 ? "/" : path.slice(0, lastSlash);
  }

  private ensureParentDirs(path: string): void {
    Filesystem.ensureParentDirs(this.entries, path);
  }

  private static ensureParentDirs(entries: Map<string, FsEntry>, path: string): void {
    const parts = path.split("/").filter(Boolean);
    let current = "";

    for (let i = 0; i < parts.length - 1; i++) {
      current += "/" + parts[i];
      if (!entries.has(current)) {
        entries.set(current, {
          type: "directory",
          mode: DEFAULT_DIR_MODE,
          mtime: new Date(),
        });
      }
    }
  }

  private resolveSymlinks(path: string, maxDepth = 10): FsEntry | null {
    let current = path;
    let depth = 0;

    while (depth < maxDepth) {
      const entry = this.entries.get(current);
      if (!entry) return null;
      if (entry.type !== "symlink") return entry;

      // Resolve symlink
      const target = entry.target;
      current = target.startsWith("/")
        ? this.normalizePath(target)
        : this.resolvePath(this.getParentPath(current) ?? "/", target);
      depth++;
    }

    throw new Error(`ELOOP: too many levels of symbolic links, stat '${path}'`);
  }

  private entryToStat(entry: FsEntry): FsStat {
    return {
      isFile: entry.type === "file",
      isDirectory: entry.type === "directory",
      isSymbolicLink: entry.type === "symlink",
      mode: entry.mode,
      size: entry.type === "file" ? this.getContentSize(entry.content) : 0,
      mtime: entry.mtime,
    };
  }

  private getContentSize(content: string | Uint8Array): number {
    if (typeof content === "string") {
      return new TextEncoder().encode(content).byteLength;
    }
    return content.byteLength;
  }

  private cloneEntry(entry: FsEntry): FsEntry {
    if (entry.type === "file") {
      return {
        type: "file",
        content:
          entry.content instanceof Uint8Array
            ? new Uint8Array(entry.content)
            : entry.content,
        mode: entry.mode,
        mtime: new Date(),
      };
    }
    return { ...entry, mtime: new Date() };
  }

  private checkSizeLimit(content: FileContent): void {
    const currentSize = this.getSize();
    const newSize =
      typeof content === "string"
        ? content.length * 2
        : content.byteLength;

    if (currentSize + newSize > this.maxSizeBytes) {
      throw new Error(
        `ENOSPC: filesystem size limit exceeded (${this.maxSizeBytes} bytes)`
      );
    }
  }

  private getEncoding(
    options?: ReadFileOptions | BufferEncoding
  ): BufferEncoding | null {
    if (!options) return null;
    if (typeof options === "string") return options as BufferEncoding;
    return options.encoding ?? null;
  }

  private decodeBuffer(buffer: Uint8Array, encoding: BufferEncoding): string {
    if (encoding === "utf8" || encoding === "utf-8") {
      return new TextDecoder("utf-8").decode(buffer);
    }
    if (encoding === "base64") {
      return this.encodeBase64(buffer);
    }
    if (encoding === "hex") {
      return Array.from(buffer)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }
    // Default to utf8 for other encodings
    return new TextDecoder("utf-8").decode(buffer);
  }

  private encodeBase64(buffer: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < buffer.byteLength; i++) {
      binary += String.fromCharCode(buffer[i]!);
    }
    return btoa(binary);
  }

  private concatBuffers(a: Uint8Array, b: Uint8Array): Uint8Array {
    const result = new Uint8Array(a.byteLength + b.byteLength);
    result.set(a, 0);
    result.set(b, a.byteLength);
    return result;
  }

  private static parseFileInit(value: FileContent | FileInit): FileInit {
    if (typeof value === "string" || value instanceof Uint8Array) {
      return { content: value };
    }
    return value;
  }
}

/**
 * Create an in-memory filesystem.
 * 
 * @param initialFiles - Optional initial files to populate the filesystem
 * @returns A new Filesystem instance
 */
export function createFilesystem(options?: FilesystemOptions): Filesystem {
  return Filesystem.create(options);
}

export function wrapFilesystemForJustBash(fs: Filesystem): IFileSystem {
  return {
    readFile: async (path: string, options?: ReadFileOptions | BufferEncoding): Promise<string> => fs.readFile(path, options),
    writeFile: async (path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void> => fs.writeFile(path, content, options),
    appendFile: async (path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void> => fs.appendFile(path, content, options),
    exists: async (path: string): Promise<boolean> => fs.exists(path),
    stat: async (path: string): Promise<FsStat> => fs.stat(path),
    lstat: async (path: string): Promise<FsStat> => fs.lstat(path),
    mkdir: async (path: string, options?: MkdirOptions): Promise<void> => fs.mkdir(path, options),
    readdir: async (path: string): Promise<string[]> => fs.readdir(path),
    readdirWithFileTypes: async (path: string): Promise<DirentEntry[]> => fs.readdirWithFileTypes(path),
    rm: async (path: string, options?: RmOptions) => fs.rm(path, options),
    cp: async (src: string, dest: string, options?: CpOptions): Promise<void> => fs.cp(src, dest, options),
    mv: async (src: string, dest: string): Promise<void> => fs.mv(src, dest),
    chmod: async (path: string, mode: number) => fs.chmod(path, mode),
    symlink: async (target: string, linkPath: string): Promise<void> => fs.symlink(target, linkPath),
    link: async (existingPath: string, newPath: string) => fs.link(existingPath, newPath),
    readlink: async (path: string): Promise<string> => fs.readlink(path),
    realpath: async (path: string): Promise<string> => fs.realpath(path),
    utimes: async (path: string, atime: Date, mtime: Date): Promise<void> => fs.utimes(path, atime, mtime),
    readFileBuffer: async (path: string): Promise<Uint8Array> => fs.readFileBuffer(path),
    resolvePath: (base: string, path: string): string => fs.resolvePath(base, path),
    getAllPaths: (): string[] => fs.getAllPaths(),
  };
}
