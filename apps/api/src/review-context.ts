import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, stat as statFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

type Exchange = { prompt: string; reply: string; images: Array<{ label: string; path: string }> };

// Role context is private state, never a Run event or a Main Agent memory item.
// Replay bounded complete exchanges, not an unbounded chat or provider-only ID.
export class ReviewContext {
  constructor(private readonly root: string, private readonly role: "verifier" | "supervisor", private readonly model: string) {}

  private path(runId: string) {
    const key = createHash("sha256").update(`${runId}:${this.role}:${this.model}`).digest("hex");
    return join(this.root, "sealed", "review-context", `${key}.json`);
  }

  async read(runId: string): Promise<Exchange[]> {
    try { return JSON.parse(await readFile(this.path(runId), "utf8")) as Exchange[]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }

  async preview(path: string) {
    const bytes = await readFile(path);
    const key = createHash("sha256").update(bytes).digest("hex");
    const directory = join(this.root, "sealed", "review-previews");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const output = join(directory, `${key}-1024.png`);
    try { await statFile(output); return output; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const preview = await sharp(bytes).resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true }).png().toBuffer();
    const temporary = `${output}.${randomUUID()}.tmp`;
    await writeFile(temporary, preview, { mode: 0o600 });
    await rename(temporary, output);
    return output;
  }

  async append(runId: string, exchange: Exchange) {
    const path = this.path(runId);
    await mkdir(join(this.root, "sealed", "review-context"), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    const history = [...await this.read(runId), { ...exchange, prompt: exchange.prompt.slice(0, 6000), reply: exchange.reply.slice(0, 12000) }].slice(-4);
    await writeFile(temporary, JSON.stringify(history), { mode: 0o600 });
    await rename(temporary, path);
  }
}
