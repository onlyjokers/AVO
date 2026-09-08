import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SVG_ENGINE_REVISION } from "../src/svg-editor.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const source = join(root, "tmp", "svg-mcp-source");
const environment = join(root, "tmp", "svg-mcp-venv");
const revision = SVG_ENGINE_REVISION.split("@")[1]!;
const run = (command: string, args: string[], cwd = root) => execFileSync(command, args, { cwd, stdio: "inherit" });
await mkdir(join(root, "tmp"), { recursive: true });
if (!existsSync(source)) {
  run("git", ["clone", "--no-checkout", "https://github.com/georgeharker/svg-mcp.git", source]);
  run("git", ["checkout", "--detach", revision], source);
}
const current = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim();
if (current !== revision) throw new Error(`svg_source_revision_mismatch: expected ${revision}; use a clean dependency checkout at that revision`);
if (!existsSync(join(environment, "bin", "python"))) run("uv", ["venv", "--python", process.env.AVO_SVG_PYTHON ?? "3.13", environment]);
run("uv", ["pip", "install", "--python", join(environment, "bin", "python"), "-r", join(root, "apps/api/svg-mcp-requirements.txt")]);
run("uv", ["pip", "install", "--python", join(environment, "bin", "python"), "--no-deps", source]);
run(join(environment, "bin", "svg-mcp"), ["--help"]);
const freeze = execFileSync("uv", ["pip", "freeze", "--python", join(environment, "bin", "python")], { encoding: "utf8" });
await writeFile(join(environment, "verified-environment.txt"), `${SVG_ENGINE_REVISION}\n${freeze}`);
console.log(`SVG MCP installed at ${join(environment, "bin", "svg-mcp")}. Run the real svg-editor test before enabling a live experiment.`);
