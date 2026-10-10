import { writeFileSync } from "node:fs";
import { TextDecoder } from "node:util";

const [output] = process.argv.slice(2);
const MAX_BYTES = 1024 * 1024;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Escape sequences can span separate text-delta records. Never buffer their payload.
class TerminalText {
  private state: "text" | "escape" | "csi" | "string" | "string-escape" = "text";
  clean(text: string): string {
    let safe = "";
    for (const char of text) {
      const code = char.codePointAt(0)!;
      if (this.state === "string" || this.state === "string-escape") {
        if (code === 7 || code === 0x9c || this.state === "string-escape" && char === "\\") this.state = "text";
        else this.state = code === 27 ? "string-escape" : "string";
        continue;
      }
      if (code === 27) { this.state = "escape"; continue; }
      if (code === 0x9b) { this.state = "csi"; continue; }
      if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) { this.state = "string"; continue; }
      if (this.state === "escape") {
        if (char === "[") this.state = "csi";
        else if ("]PX^_".includes(char)) this.state = "string";
        else if (code < 0x20 || code > 0x2f) this.state = "text";
        continue;
      }
      if (this.state === "csi") {
        if (code >= 0x40 && code <= 0x7e) this.state = "text";
        continue;
      }
      if ((code < 32 && char !== "\n" && char !== "\t") || code >= 0x7f && code <= 0x9f ||
          /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(char)) continue;
      safe += char;
    }
    return safe;
  }
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const displayFilter = new TerminalText();
let pending = "";
let result: Record<string, unknown> | undefined;
let displayed = 0;
let failed = false;
function fail(reason: string): never {
  failed = true;
  console.error(`Claude stream formatter: ${reason}`);
  process.exit(1);
}
process.stdout.on("error", () => fail("pane output failed"));
function show(safe: string) {
  if (displayed >= 20_000 || failed) return;
  let bounded = safe.slice(0, 20_000 - displayed);
  const last = bounded.charCodeAt(bounded.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) bounded = bounded.slice(0, -1);
  displayed += bounded.length;
  if (bounded) process.stdout.write(bounded);
}
function line(raw: string) {
  if (Buffer.byteLength(raw) > MAX_BYTES) fail("record exceeds 1 MiB");
  let event: Record<string, any>;
  try {
    event = JSON.parse(raw);
    if (!event || typeof event !== "object" || Array.isArray(event)) throw Error();
  } catch { fail("malformed record"); }
  if (event.type === "result") {
    if (result) fail("duplicate terminal result");
    const text = typeof event.result === "string" ? new TerminalText().clean(event.result) : "";
    if (typeof event.session_id !== "string" || !SESSION_ID.test(event.session_id) ||
        typeof event.is_error !== "boolean" || typeof event.subtype !== "string" ||
        event.is_error === false && (event.subtype !== "success" || !text.trim())) fail("invalid terminal result");
    result = { type: "result", subtype: event.subtype, is_error: event.is_error, result: text, session_id: event.session_id };
    return;
  }
  // Native informational records may follow the terminal result. Never mirror them.
  if (result) return;
  if (event.type === "stream_event" && event.event?.type === "content_block_delta" &&
      event.event.delta?.type === "text_delta" && typeof event.event.delta.text === "string") {
    show(displayFilter.clean(event.event.delta.text));
  }
  if (event.type === "assistant" && Array.isArray(event.message?.content)) {
    for (const block of event.message.content) {
      if (block?.type === "tool_use" && ["Read", "Glob", "Grep"].includes(block.name)) show(`[${block.name}]\n`);
    }
  }
}
try {
  const stream = process.stdin;
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = pending.indexOf("\n")) >= 0) {
      line(pending.slice(0, end));
      pending = pending.slice(end + 1);
    }
    if (Buffer.byteLength(pending) > MAX_BYTES) fail("record exceeds 1 MiB");
  }
  pending += decoder.decode();
  if (pending.trim() || !result) fail("truncated or missing terminal result");
  const final = JSON.stringify(result);
  if (Buffer.byteLength(final) > MAX_BYTES) fail("result exceeds 1 MiB");
  writeFileSync(output, final, { mode: 0o600 });
  if (result.is_error) process.exitCode = 1;
} catch { fail("stream decoding or IO failed"); }
