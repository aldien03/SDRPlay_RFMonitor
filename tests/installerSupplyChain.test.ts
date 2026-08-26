import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("Ubuntu installer supply-chain boundary", () => {
  it("never downloads a mutable setup script for execution", async () => {
    const installer = await readFile(path.join(repositoryRoot, "deploy/install-ubuntu.sh"), "utf8");
    expect(installer).not.toContain("deb.nodesource.com/setup_");
    expect(installer).not.toContain("sdrplay.com/software/install.sh");
    expect(installer).not.toMatch(/curl[^\n]+\n\s*(?:privileged\s+)?bash\b/);
  });

  it("pins the exact signed APT candidate selected for Node.js", async () => {
    const installer = await readFile(path.join(repositoryRoot, "deploy/install-ubuntu.sh"), "utf8");
    expect(installer).toContain('apt-cache policy nodejs');
    expect(installer).toContain('apt-get install -y "nodejs=${node_candidate}"');
    expect(installer).toContain("configured signed APT repositories");
  });
});
