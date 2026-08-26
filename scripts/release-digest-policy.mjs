import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

export const RELEASE_SOURCE_ROOTS = Object.freeze([
  "src", "scripts", "tests", "worker", "config", "deploy", "docs", "README.md", "install.sh", "package.json", "package-lock.json",
  "tsconfig.json", "vite.config.mjs", "vitest.config.ts",
]);
export const RELEASE_PACKAGE_ROOTS = Object.freeze([
  "src", "scripts", "worker", "config", "deploy", "docs", "dist/client", "dist/server", "dist/server-node", "dist/.openai", "README.md", "install.sh", "package.json", "package-lock.json",
]);

export async function walkReleaseFiles(repositoryRoot, relativeRoots) {
  const root = path.resolve(repositoryRoot);
  const files = [];
  const pending = [...relativeRoots].reverse();
  while (pending.length) {
    const relative = pending.pop();
    const absolute = path.join(root, relative);
    let details;
    try {
      details = await stat(absolute);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (details.isFile()) {
      if (details.size > MAX_FILE_BYTES) throw new Error(`Release input is too large: ${relative}`);
      files.push(relative.split(path.sep).join("/"));
      if (files.length > MAX_FILES) throw new Error("Release input exceeds its file-count bound");
      continue;
    }
    if (!details.isDirectory()) continue;
    const entries = await readdir(absolute, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name)).reverse()) {
      if (!entry.isSymbolicLink()) pending.push(path.join(relative, entry.name));
    }
  }
  return files.sort();
}

export async function digestReleaseFiles(repositoryRoot, relativeRoots, emptyLabel) {
  const root = path.resolve(repositoryRoot);
  const files = await walkReleaseFiles(root, relativeRoots);
  if (!files.length) return createHash("sha256").update(emptyLabel).digest("hex");
  const digest = createHash("sha256");
  for (const relative of files) {
    digest.update(relative);
    digest.update("\0");
    digest.update(await readFile(path.join(root, ...relative.split("/"))));
    digest.update("\0");
  }
  return digest.digest("hex");
}
