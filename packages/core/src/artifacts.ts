import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { artifactSchema, type Artifact } from "@avo/contracts";
import { fileTypeFromBuffer } from "file-type";

const extensionByMime = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
} as const;

const atomicWrite = async (path: string, contents: Buffer | string) => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, contents);
  await rename(temporary, path);
};

export class ArtifactStore {
  constructor(private readonly dataDir: string) {}

  private binaryPath(sha256: string, mimeType: Artifact["mime_type"]) {
    return join(this.dataDir, "blobs", "sha256", sha256.slice(0, 2), `${sha256}.${extensionByMime[mimeType]}`);
  }

  private metadataPath(sha256: string) {
    return join(this.dataDir, "blobs", "sha256", sha256.slice(0, 2), `${sha256}.json`);
  }

  async put(input: { bytes: Buffer; mimeType: Artifact["mime_type"]; originalName: string }): Promise<Artifact> {
    const detected = await fileTypeFromBuffer(input.bytes);
    const normalizedDetected = detected?.mime === "image/jpg" ? "image/jpeg" : detected?.mime;
    if (normalizedDetected !== input.mimeType) throw new Error("artifact_mime_mismatch");
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const metadataPath = this.metadataPath(sha256);
    try {
      return artifactSchema.parse(JSON.parse(await readFile(metadataPath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const artifact = artifactSchema.parse({
      id: `sha256:${sha256}`,
      sha256,
      mime_type: input.mimeType,
      size_bytes: input.bytes.byteLength,
      original_name: input.originalName,
      created_at: new Date().toISOString(),
    });
    await atomicWrite(this.binaryPath(sha256, input.mimeType), input.bytes);
    await atomicWrite(metadataPath, `${JSON.stringify(artifact, null, 2)}\n`);
    return artifact;
  }

  async get(id: string): Promise<{ artifact: Artifact; path: string; bytes: Buffer }> {
    const sha256 = id.replace(/^sha256:/, "");
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("invalid_artifact_id");
    const artifact = artifactSchema.parse(JSON.parse(await readFile(this.metadataPath(sha256), "utf8")));
    const path = this.binaryPath(sha256, artifact.mime_type);
    return { artifact, path, bytes: await readFile(path) };
  }

  async exists(id: string) {
    try {
      await this.get(id);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async removeIfUnreferenced(id: string, referenced: boolean) {
    if (referenced) return false;
    const { artifact, path } = await this.get(id);
    await unlink(path).catch(() => undefined);
    await unlink(this.metadataPath(artifact.sha256)).catch(() => undefined);
    return true;
  }

  async size(id: string) {
    const { path } = await this.get(id);
    return (await stat(path)).size;
  }
}
