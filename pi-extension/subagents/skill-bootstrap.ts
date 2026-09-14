import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { isAbsolute, relative, sep } from "node:path";
import type { CanonicalSkillSnapshot } from "./resume-policy.ts";

export type SkillBootstrapDiagnostic = Readonly<{
  code:
    | "invalid-requested-skill"
    | "duplicate-requested-skill"
    | "requested-skill-unavailable"
    | "invalid-skill-source"
    | "unreadable-skill";
  message: string;
  skillName?: string;
  path?: string;
}>;

export type SkillBootstrapResult =
  | { ok: true; text: string; skills: CanonicalSkillSnapshot[] }
  | { ok: false; diagnostic: SkillBootstrapDiagnostic };

function stripFrontmatter(content: string): string {
  const normalized = content
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) return normalized;
  const endIndex = normalized.indexOf("\n---", 3);
  return endIndex === -1 ? normalized : normalized.slice(endIndex + 4).trim();
}

function validCanonicalSource(path: string, baseDir: string): boolean {
  if (!isAbsolute(path) || !isAbsolute(baseDir)) return false;
  const relativePath = relative(baseDir, path);
  return relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

function skillBlock(skill: CanonicalSkillSnapshot): string {
  return `<skill name="${skill.name}" location="${skill.filePath}">\n` +
    `References are relative to ${skill.baseDir}.\n\n` +
    `${skill.content}\n</skill>`;
}

function prependSkills(input: string, skills: readonly CanonicalSkillSnapshot[]): string {
  return skills.length === 0 ? input : `${skills.map(skillBlock).join("\n\n")}\n\n${input}`;
}

export function buildSkillBootstrappedInputFromSnapshots(params: {
  input: string;
  skills: readonly CanonicalSkillSnapshot[];
}): { text: string } {
  return { text: prependSkills(params.input, params.skills) };
}

export function buildSkillBootstrappedInput(params: {
  input: string;
  requestedNames: readonly string[];
  commands: readonly SlashCommandInfo[];
  readSkill: (path: string) => string;
}): SkillBootstrapResult {
  if (params.requestedNames.length === 0) return { ok: true, text: params.input, skills: [] };

  const seen = new Set<string>();
  for (const requestedName of params.requestedNames) {
    if (!requestedName.trim()) {
      return {
        ok: false,
        diagnostic: {
          code: "invalid-requested-skill",
          message: "Requested skill names must be nonblank",
        },
      };
    }
    if (seen.has(requestedName)) {
      return {
        ok: false,
        diagnostic: {
          code: "duplicate-requested-skill",
          skillName: requestedName,
          message: `Requested skill "${requestedName}" is duplicated`,
        },
      };
    }
    seen.add(requestedName);
  }

  const skills: CanonicalSkillSnapshot[] = [];
  for (const name of params.requestedNames) {
    const command = params.commands.find(
      (candidate) => candidate.source === "skill" && candidate.name === `skill:${name}`,
    );
    if (!command) {
      return {
        ok: false,
        diagnostic: {
          code: "requested-skill-unavailable",
          skillName: name,
          message: `Requested skill "${name}" is unavailable in the child session`,
        },
      };
    }

    const filePath = command.sourceInfo.path;
    const baseDir = command.sourceInfo.baseDir;
    if (typeof baseDir !== "string" || !validCanonicalSource(filePath, baseDir)) {
      return {
        ok: false,
        diagnostic: {
          code: "invalid-skill-source",
          skillName: name,
          path: filePath,
          message: `Canonical source for skill "${name}" is invalid`,
        },
      };
    }

    let content: string;
    try {
      content = stripFrontmatter(params.readSkill(filePath)).trim();
    } catch (error) {
      return {
        ok: false,
        diagnostic: {
          code: "unreadable-skill",
          skillName: name,
          path: filePath,
          message: `Unable to read skill "${name}" from ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
    skills.push({ name, filePath, baseDir, content });
  }

  return {
    ok: true,
    text: prependSkills(params.input, skills),
    skills,
  };
}
