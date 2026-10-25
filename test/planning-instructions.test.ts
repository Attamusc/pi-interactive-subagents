import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const skill = read("pi-extension/subagents/plan-skill.md");
const planner = read("agents/planner.md");

test("supporting planner path resolves from the injected skill, not a different project", () => {
  const relative = skill.match(/bundled `([^`]+)` guidance/)?.[1];
  assert.equal(relative, "../../agents/planner.md");
  assert.match(skill, /relative to this skill's injected file location/);
  assert.match(skill, /never relative to the user project's current working directory/);
  const temporary = mkdtempSync(join(tmpdir(), "planning-package-layout-"));
  try {
    const packageRoot = join(temporary, "package");
    const projectRoot = join(temporary, "different-project");
    mkdirSync(join(packageRoot, "pi-extension", "subagents"), { recursive: true });
    mkdirSync(join(packageRoot, "agents"));
    mkdirSync(join(projectRoot, "agents"), { recursive: true });
    writeFileSync(join(packageRoot, "agents", "planner.md"), planner);
    writeFileSync(join(projectRoot, "agents", "planner.md"), "unrelated project planner");
    const injectedLocation = pathToFileURL(join(packageRoot, "pi-extension", "subagents", "plan-skill.md"));
    assert.equal(readFileSync(new URL(relative!, injectedLocation), "utf8"), planner);
    assert.notEqual(readFileSync(join(projectRoot, "agents", "planner.md"), "utf8"), planner);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("claim ownership matches the unchanged worker and delegated approval stays with the orchestrator", () => {
  const worker = read("agents/worker.md");
  assert.match(worker, /todo\(action: "claim", id: "TODO-xxxx"\)/);
  assert.match(worker, /release the todo/);
  for (const source of [skill, planner]) {
    assert.match(source, /unclaimed and eligible/);
    assert.match(source, /without claiming on the worker's behalf/);
    assert.match(source, /implementation worker fetches and claims/i);
    assert.match(source, /authoritative task scope before writes/);
    assert.match(source, /mismatch must pause before writes/);
    assert.match(source, /planner is the sole writer/);
    assert.match(source, /main author\/orchestrator presents the reviewed proposal and collects/i);
    assert.match(source, /delegated planner does not ask for permission to build or activate tasks/);
    assert.match(source, /identical reviewed version need not be re-asked/);
    assert.match(source, /summary, completion handshake, or approval of a direction alone is not proof/);
    assert.match(source, /host\/repository-declared task capability and tracker conventions/);
    assert.match(source, /when that managed path is configured/);
    assert.match(source, /report the gap before ticket operations; do not invent a backend or silently proceed/);
    assert.doesNotMatch(source, /orchestrator retains dependency checks and claims|before claiming\/delegating/);
  }
});

// Source consistency, not proof that a model follows these instructions.
test("main-session planning and delegated planning share the proposal and consent contract", () => {
  for (const source of [skill, planner]) {
    for (const contract of [/current conversation/, /250–400 words/, /source-discoverable facts rather than asking the user/, /unchanged scope|stays unchanged/, /observable success/i, /potential harm/i, /recovery/, /fresh read-only reviewer/, /without.*conversation/, /one (?:fresh )?re-review/, /explicit execution approval/, /planning-only/i, /material (?:proposal\/task )?change/i, /contract validation/, /tools: "read"/, /subagent_done/]) {
      assert.match(source, contract);
    }
    assert.doesNotMatch(source, /## Phase \d|Always spawn a scout|MUST follow all phases|Ctrl\+D|write-todos/);
  }
  assert.match(skill, /agent: "planner", interactive: true/);
  assert.match(skill, /Tasks remain draft|tasks as `draft`/i);
  assert.match(planner, /inline acceptance criteria/i);
});

test("plan command still injects instructions and iterate remains a full-context fork", () => {
  const index = read("pi-extension/subagents/index.ts");
  assert.match(index, /plan-skill\.md/);
  assert.match(index, /registerCommand\("plan"/);
  assert.match(index, /registerCommand\("iterate"/);
  assert.match(read("README.md"), /always forks the current session.*full conversation context/);
});
