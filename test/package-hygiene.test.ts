import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("package hygiene", () => {
  it("packs runtime sources without Jujutsu metadata", () => {
    const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const files = JSON.parse(output)[0].files.map((entry: { path: string }) => entry.path);

    const runtimeSources = readdirSync(join(root, "pi-extension", "subagents"), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => `pi-extension/subagents/${entry.name}`)
      .sort();

    assert.deepEqual(
      files.filter((path: string) => /^pi-extension\/subagents\/[^/]+\.ts$/.test(path)).sort(),
      runtimeSources,
    );
    assert.equal(files.some((path: string) => path === ".jj" || path.startsWith(".jj/")), false);
  });
});
