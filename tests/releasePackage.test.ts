import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateReleaseMetadata } from "../scripts/generate-release-metadata.mjs";
import { validateReleasePackage } from "../scripts/validate-release-package.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "rf-monitor-release-package-"));
  roots.push(root);
  await Promise.all([
    mkdir(path.join(root, "src"), { recursive: true }),
    mkdir(path.join(root, "scripts"), { recursive: true }),
    mkdir(path.join(root, "dist", "client"), { recursive: true }),
    mkdir(path.join(root, "dist", "server"), { recursive: true }),
    mkdir(path.join(root, "dist", "server-node"), { recursive: true }),
    mkdir(path.join(root, "dist", ".openai"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(root, "package.json"), JSON.stringify({ name: "rf-monitor", version: "1.2.3" })),
    writeFile(path.join(root, "package-lock.json"), "lock\n"),
    writeFile(path.join(root, "src", "index.ts"), "export const value = 1;\n"),
    writeFile(path.join(root, "scripts", "build.mjs"), "// fixture\n"),
    writeFile(path.join(root, "dist", "client", "index.html"), "<!doctype html><html><head></head><body></body></html>\n"),
    writeFile(path.join(root, "dist", "client", "app.js"), "console.log('fixture');\n"),
    writeFile(path.join(root, "dist", "server", "index.js"), "export default {};\n"),
    writeFile(path.join(root, "dist", "server-node", "index.js"), "console.log('server');\n"),
    writeFile(path.join(root, "dist", ".openai", "hosting.json"), "{}\n"),
  ]);
  await generateReleaseMetadata({ repositoryRoot: root, environment: {} });
  return root;
}

describe("release package validation", () => {
  it("[trace:REL-010] matches the embedded client identity and every package digest", async () => {
    const root = await fixture();
    await expect(validateReleasePackage({ repositoryRoot: root })).resolves.toMatchObject({
      valid: true,
      releaseVersion: "1.2.3",
      buildId: expect.stringMatching(/^1\.2\.3\+[a-f0-9]{12}$/),
    });
  });

  it("fails closed when the embedded client build ID is stale or duplicated", async () => {
    const root = await fixture();
    const indexPath = path.join(root, "dist", "client", "index.html");
    const index = await readFile(indexPath, "utf8");
    await writeFile(indexPath, index.replace(/content="[^"]+"/, 'content="stale-client"'));
    await expect(validateReleasePackage({ repositoryRoot: root })).rejects.toThrow(/client build ID does not match/i);

    await generateReleaseMetadata({ repositoryRoot: root, environment: {} });
    const repaired = await readFile(indexPath, "utf8");
    await writeFile(indexPath, repaired.replace("</head>", `${repaired.match(/<meta name="rf-monitor-client-build-id"[^>]+>/)?.[0]}</head>`));
    await expect(validateReleasePackage({ repositoryRoot: root })).rejects.toThrow(/exactly one embedded build ID/i);
  });

  it("detects source and package mutation after release metadata is written", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "src", "index.ts"), "export const value = 2;\n");
    await expect(validateReleasePackage({ repositoryRoot: root })).rejects.toThrow(/source digest/i);

    await generateReleaseMetadata({ repositoryRoot: root, environment: {} });
    await writeFile(path.join(root, "dist", "client", "app.js"), "console.log('tampered');\n");
    await expect(validateReleasePackage({ repositoryRoot: root })).rejects.toThrow(/package digest/i);
  });
});
