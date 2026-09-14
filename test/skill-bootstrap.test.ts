import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import {
  buildSkillBootstrappedInput,
  buildSkillBootstrappedInputFromSnapshots,
} from "../pi-extension/subagents/skill-bootstrap.ts";

function skillCommand(name: string, path = `/skills/${name}/SKILL.md`): SlashCommandInfo {
  return {
    name: `skill:${name}`,
    description: `${name} skill`,
    source: "skill",
    sourceInfo: {
      path,
      source: "local",
      scope: "user",
      origin: "top-level",
      baseDir: path.slice(0, path.lastIndexOf("/")),
    },
  };
}

const files: Record<string, string> = {
  "/skills/first/SKILL.md": "---\r\nname: first\r\ndescription: First skill\r\n---\r\n\r\n# First instructions\r\n\r\nDo first.\r\n",
  "/skills/second/SKILL.md": "---\nname: second\ndescription: Second skill\n---\n# Second instructions\n",
};

function readSkill(path: string): string {
  if (!(path in files)) throw new Error(`ENOENT: ${path}`);
  return files[path]!;
}

describe("skill bootstrap", () => {
  it("returns a zero-skill task byte-for-byte", () => {
    assert.deepEqual(buildSkillBootstrappedInput({
      input: "TASK\n",
      requestedNames: [],
      commands: [],
      readSkill,
    }), { ok: true, text: "TASK\n", skills: [] });
  });

  it("places one canonical Pi skill block before the task", () => {
    assert.deepEqual(buildSkillBootstrappedInput({
      input: "TASK_TEXT",
      requestedNames: ["first"],
      commands: [skillCommand("first")],
      readSkill,
    }), {
      ok: true,
      text: '<skill name="first" location="/skills/first/SKILL.md">\nReferences are relative to /skills/first.\n\n# First instructions\n\nDo first.\n</skill>\n\nTASK_TEXT',
      skills: [{
        name: "first",
        filePath: "/skills/first/SKILL.md",
        baseDir: "/skills/first",
        content: "# First instructions\n\nDo first.",
      }],
    });
  });

  it("preserves requested order and the child-selected first collision winner", () => {
    const collidingFirst = skillCommand("first", "/project/first/SKILL.md");
    const result = buildSkillBootstrappedInput({
      input: "TASK",
      requestedNames: ["second", "first"],
      commands: [collidingFirst, skillCommand("first"), skillCommand("second")],
      readSkill: (path) => path === "/project/first/SKILL.md"
        ? "---\nname: first\ndescription: Project winner\n---\nPROJECT FIRST"
        : readSkill(path),
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.skills.map((skill) => [skill.name, skill.filePath]), [
      ["second", "/skills/second/SKILL.md"],
      ["first", "/project/first/SKILL.md"],
    ]);
    assert.equal(result.text.indexOf("# Second instructions") < result.text.indexOf("PROJECT FIRST"), true);
    assert.equal(result.text.endsWith("</skill>\n\nTASK"), true);
  });

  it("replays persisted snapshots without rediscovering or rereading skills", () => {
    assert.deepEqual(buildSkillBootstrappedInputFromSnapshots({
      input: "RESUME_TASK",
      skills: [{
        name: "first",
        filePath: "/original/first/SKILL.md",
        baseDir: "/original/first",
        content: "ORIGINAL INSTRUCTIONS",
      }],
    }), {
      text: '<skill name="first" location="/original/first/SKILL.md">\nReferences are relative to /original/first.\n\nORIGINAL INSTRUCTIONS\n</skill>\n\nRESUME_TASK',
    });
  });

  it("returns structured diagnostics before reading unavailable or duplicate skills", () => {
    assert.deepEqual(buildSkillBootstrappedInput({
      input: "TASK",
      requestedNames: ["missing"],
      commands: [skillCommand("first")],
      readSkill,
    }), {
      ok: false,
      diagnostic: {
        code: "requested-skill-unavailable",
        skillName: "missing",
        message: 'Requested skill "missing" is unavailable in the child session',
      },
    });

    assert.deepEqual(buildSkillBootstrappedInput({
      input: "TASK",
      requestedNames: ["first", "first"],
      commands: [skillCommand("first")],
      readSkill,
    }), {
      ok: false,
      diagnostic: {
        code: "duplicate-requested-skill",
        skillName: "first",
        message: 'Requested skill "first" is duplicated',
      },
    });

    assert.deepEqual(buildSkillBootstrappedInput({
      input: "TASK",
      requestedNames: ["  "],
      commands: [],
      readSkill,
    }), {
      ok: false,
      diagnostic: {
        code: "invalid-requested-skill",
        message: "Requested skill names must be nonblank",
      },
    });
  });

  it("rejects malformed provenance and unreadable canonical files", () => {
    const malformed = skillCommand("first");
    malformed.sourceInfo.baseDir = "/other";
    assert.deepEqual(buildSkillBootstrappedInput({
      input: "TASK",
      requestedNames: ["first"],
      commands: [malformed],
      readSkill,
    }), {
      ok: false,
      diagnostic: {
        code: "invalid-skill-source",
        skillName: "first",
        path: "/skills/first/SKILL.md",
        message: 'Canonical source for skill "first" is invalid',
      },
    });

    assert.deepEqual(buildSkillBootstrappedInput({
      input: "TASK",
      requestedNames: ["first"],
      commands: [skillCommand("first", "/missing/first/SKILL.md")],
      readSkill,
    }), {
      ok: false,
      diagnostic: {
        code: "unreadable-skill",
        skillName: "first",
        path: "/missing/first/SKILL.md",
        message: 'Unable to read skill "first" from /missing/first/SKILL.md: ENOENT: /missing/first/SKILL.md',
      },
    });
  });
});
