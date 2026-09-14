import { readFileSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

export const RESUME_POLICY_CUSTOM_TYPE = "pi-interactive-subagents.resume-policy";
export const RESUME_POLICY_ENV = "PI_SUBAGENT_LAUNCH_POLICY";
export const RESUME_POLICY_RESTORE_ENV = "PI_SUBAGENT_RESTORE_POLICY";

export interface CanonicalSkillSnapshot {
  name: string;
  filePath: string;
  baseDir: string;
  content: string;
}

export interface LaunchPolicySeed {
  version: 2;
  agent: string | null;
  deniedTools: string[];
  cwd: string;
  agentDir: string;
  systemPrompt: { mode: "append" | "replace" | null; text: string } | null;
  requestedSkills: string[];
}

export interface ResumePolicy extends LaunchPolicySeed {
  sessionId: string;
  activeTools: string[];
  skills: CanonicalSkillSnapshot[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    const unexpected = actual.filter((key) => !wanted.includes(key));
    throw new Error(
      unexpected.length > 0
        ? `${label} has unexpected field: ${unexpected.join(", ")}`
        : `${label} is missing required fields`,
    );
  }
}

function parseStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${field} must be an array of nonblank strings`);
  }
  const normalized = value.map((item) => item.trim());
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${field} must not contain duplicates`);
  }
  return normalized;
}

function parseSystemPrompt(value: unknown): LaunchPolicySeed["systemPrompt"] {
  if (value === null) return null;
  if (!isRecord(value)) throw new Error("systemPrompt must be null or an object");
  assertExactKeys(value, ["mode", "text"], "systemPrompt");
  if (value.mode !== null && value.mode !== "append" && value.mode !== "replace") {
    throw new Error("systemPrompt.mode must be append, replace, or null");
  }
  if (typeof value.text !== "string") throw new Error("systemPrompt.text must be a string");
  return { mode: value.mode, text: value.text } as LaunchPolicySeed["systemPrompt"];
}

function parseSkillSnapshot(value: unknown, index: number): CanonicalSkillSnapshot {
  const label = `skills[${index}]`;
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertExactKeys(value, ["name", "filePath", "baseDir", "content"], label);
  if (typeof value.name !== "string" || !value.name.trim()) {
    throw new Error(`${label}.name must be a nonblank string`);
  }
  if (typeof value.filePath !== "string" || !isAbsolute(value.filePath)) {
    throw new Error(`${label}.filePath must be an absolute path`);
  }
  if (typeof value.baseDir !== "string" || !isAbsolute(value.baseDir)) {
    throw new Error(`${label}.baseDir must be an absolute path`);
  }
  const relativePath = relative(value.baseDir, value.filePath);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`${label}.filePath must be inside baseDir`);
  }
  if (typeof value.content !== "string") throw new Error(`${label}.content must be a string`);
  return {
    name: value.name.trim(),
    filePath: value.filePath,
    baseDir: value.baseDir,
    content: value.content,
  };
}

function parseSkillSnapshots(value: unknown, requestedSkills: readonly string[]): CanonicalSkillSnapshot[] {
  if (!Array.isArray(value)) throw new Error("skills must be an array");
  const skills = value.map(parseSkillSnapshot);
  const names = skills.map((skill) => skill.name);
  if (names.length !== requestedSkills.length || names.some((name, index) => name !== requestedSkills[index])) {
    throw new Error("skills must match requestedSkills in order");
  }
  return skills;
}

function parseSeedObject(value: unknown): LaunchPolicySeed {
  if (!isRecord(value)) throw new Error("launch policy must be an object");
  assertExactKeys(
    value,
    ["version", "agent", "deniedTools", "cwd", "agentDir", "systemPrompt", "requestedSkills"],
    "launch policy",
  );
  if (value.version !== 2) throw new Error("launch policy version must be 2");
  if (value.agent !== null && (typeof value.agent !== "string" || !value.agent.trim())) {
    throw new Error("launch policy agent must be null or a nonblank string");
  }
  if (typeof value.cwd !== "string" || !isAbsolute(value.cwd)) {
    throw new Error("launch policy cwd must be an absolute path");
  }
  if (typeof value.agentDir !== "string" || !isAbsolute(value.agentDir)) {
    throw new Error("launch policy agentDir must be an absolute path");
  }
  return {
    version: 2,
    agent: value.agent === null ? null : value.agent.trim(),
    deniedTools: parseStringList(value.deniedTools, "deniedTools"),
    cwd: value.cwd,
    agentDir: value.agentDir,
    systemPrompt: parseSystemPrompt(value.systemPrompt),
    requestedSkills: parseStringList(value.requestedSkills, "requestedSkills"),
  };
}

export function serializeLaunchPolicySeed(seed: LaunchPolicySeed): string {
  return JSON.stringify(parseSeedObject(seed));
}

export function parseLaunchPolicySeed(raw: string): LaunchPolicySeed {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("launch policy is not valid JSON");
  }
  return parseSeedObject(value);
}

export function createResumePolicy(
  seed: LaunchPolicySeed,
  sessionId: string,
  activeTools: readonly string[],
  skills: readonly CanonicalSkillSnapshot[],
): ResumePolicy {
  const parsedSeed = parseSeedObject(seed);
  if (!sessionId.trim()) throw new Error("sessionId must be a nonblank string");
  const parsedTools = parseStringList(activeTools, "activeTools").sort();
  const parsedSkills = parseSkillSnapshots(skills, parsedSeed.requestedSkills);
  return { ...parsedSeed, sessionId: sessionId.trim(), activeTools: parsedTools, skills: parsedSkills };
}

function parseResumePolicy(value: unknown): ResumePolicy {
  if (!isRecord(value)) throw new Error("resume policy must be an object");
  assertExactKeys(
    value,
    [
      "version",
      "agent",
      "deniedTools",
      "cwd",
      "agentDir",
      "systemPrompt",
      "requestedSkills",
      "sessionId",
      "activeTools",
      "skills",
    ],
    "resume policy",
  );
  const seed = parseSeedObject({
    version: value.version,
    agent: value.agent,
    deniedTools: value.deniedTools,
    cwd: value.cwd,
    agentDir: value.agentDir,
    systemPrompt: value.systemPrompt,
    requestedSkills: value.requestedSkills,
  });
  if (typeof value.sessionId !== "string" || !value.sessionId.trim()) {
    throw new Error("resume policy sessionId must be a nonblank string");
  }
  return {
    ...seed,
    sessionId: value.sessionId.trim(),
    activeTools: parseStringList(value.activeTools, "activeTools").sort(),
    skills: parseSkillSnapshots(value.skills, seed.requestedSkills),
  };
}

export function readResumePolicy(sessionFile: string): ResumePolicy {
  let entries: unknown[];
  try {
    entries = readFileSync(sessionFile, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  } catch (error) {
    throw new Error(`invalid resume policy session: ${error instanceof Error ? error.message : String(error)}`);
  }

  const header = entries[0];
  if (!isRecord(header) || header.type !== "session" || typeof header.id !== "string" || !header.id) {
    throw new Error("invalid resume policy session header");
  }
  const matches = entries.filter((entry) => {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== RESUME_POLICY_CUSTOM_TYPE) return false;
    return isRecord(entry.data) && entry.data.sessionId === header.id;
  }) as Array<Record<string, unknown>>;
  if (matches.length === 0) throw new Error("missing trusted resume policy for this session id");
  if (matches.length !== 1) throw new Error("conflicting resume policies for this session id");

  try {
    return parseResumePolicy(matches[0].data);
  } catch (error) {
    throw new Error(`invalid resume policy: ${error instanceof Error ? error.message : String(error)}`);
  }
}
