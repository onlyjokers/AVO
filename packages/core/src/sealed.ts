import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileTypeFromBuffer } from "file-type";
import { assertSafeId } from "./ids.ts";
import type { SealedEvaluationInputs, SealedEvaluationResolver } from "./runner.ts";

type StagedUpload = {
  token: string;
  original_name: string;
  mime_type: "image/png" | "image/jpeg" | "image/webp";
  created_at: string;
  expires_at: string;
};

type SealedAsset = {
  key: string;
  mime_type: StagedUpload["mime_type"];
  original_name: string;
  caption?: string;
};

type SealedTaskSpec = {
  schema_version: 1;
  task_id: string;
  revision: string;
  references: SealedAsset[];
  hidden_target?: SealedAsset;
  private_rubric?: string;
  created_at: string;
};

const mimeExtension = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
} as const;

const atomicWrite = async (path: string, contents: string | Buffer) => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, contents);
  await rename(temporary, path);
};

export class SealedEvaluationStore implements SealedEvaluationResolver {
  constructor(readonly dataDir: string) {}

  async stageUpload(input: { bytes: Buffer; mimeType: string; originalName: string }) {
    const detected = await fileTypeFromBuffer(input.bytes);
    const mime = detected?.mime;
    if (mime !== input.mimeType || !["image/png", "image/jpeg", "image/webp"].includes(mime ?? "")) {
      throw new Error("sealed_artifact_mime_mismatch");
    }
    const token = randomUUID();
    const createdAt = new Date();
    const metadata: StagedUpload = {
      token,
      original_name: input.originalName.slice(0, 512),
      mime_type: mime as StagedUpload["mime_type"],
      created_at: createdAt.toISOString(),
      expires_at: new Date(createdAt.getTime() + 60 * 60_000).toISOString(),
    };
    const directory = this.uploadDir(token);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await Promise.all([
      atomicWrite(join(directory, "blob"), input.bytes),
      atomicWrite(join(directory, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`),
    ]);
    return { upload_token: token, expires_at: metadata.expires_at };
  }

  async consumeForTask(input: {
    taskId: string;
    references: Array<{ uploadToken: string; caption?: string }>;
    hiddenTargetToken?: string;
    privateRubric?: string;
  }) {
    const references = await Promise.all(input.references.map(async (reference) => ({
      ...await this.consumeUpload(reference.uploadToken),
      ...(reference.caption ? { caption: reference.caption.slice(0, 2_000) } : {}),
    })));
    const hiddenTarget = input.hiddenTargetToken ? await this.consumeUpload(input.hiddenTargetToken) : undefined;
    const createdAt = new Date().toISOString();
    const revision = createHash("sha256").update(JSON.stringify({
      references: references.map((item) => item.key),
      hidden_target: hiddenTarget?.key,
      private_rubric: input.privateRubric,
    })).digest("hex");
    const spec: SealedTaskSpec = {
      schema_version: 1,
      task_id: assertSafeId(input.taskId),
      revision,
      references,
      ...(hiddenTarget ? { hidden_target: hiddenTarget } : {}),
      ...(input.privateRubric?.trim() ? { private_rubric: input.privateRubric.trim().slice(0, 100_000) } : {}),
      created_at: createdAt,
    };
    await atomicWrite(this.taskPath(input.taskId), `${JSON.stringify(spec, null, 2)}\n`);
    return this.describe(input.taskId);
  }

  async getForTask(taskId: string): Promise<SealedEvaluationInputs | undefined> {
    const spec = await this.readSpec(taskId);
    if (!spec) return undefined;
    return {
      revision: spec.revision,
      references: spec.references.map((item) => ({
        path: this.blobPath(item),
        ...(item.caption ? { caption: item.caption } : {}),
      })),
      ...(spec.hidden_target ? { hiddenTargetPath: this.blobPath(spec.hidden_target) } : {}),
      ...(spec.private_rubric ? { privateRubric: spec.private_rubric } : {}),
    };
  }

  async describe(taskId: string) {
    const spec = await this.readSpec(taskId);
    if (!spec) return { has_hidden_evaluation: false, reference_count: 0, has_hidden_target: false, has_private_rubric: false };
    return {
      has_hidden_evaluation: true,
      reference_count: spec.references.length,
      has_hidden_target: Boolean(spec.hidden_target),
      has_private_rubric: Boolean(spec.private_rubric),
      references: spec.references.map((item, index) => ({ index, original_name: item.original_name, caption: item.caption ?? "" })),
      hidden_target_name: spec.hidden_target?.original_name ?? null,
      private_rubric: spec.private_rubric ?? "",
    };
  }

  async readAsset(taskId: string, slot: string) {
    const spec = await this.readSpec(taskId);
    if (!spec) throw new Error("sealed_evaluation_not_found");
    const asset = slot === "target"
      ? spec.hidden_target
      : /^reference-\d+$/.test(slot)
        ? spec.references[Number(slot.slice("reference-".length))]
        : undefined;
    if (!asset) throw new Error("sealed_artifact_not_found");
    return { bytes: await readFile(this.blobPath(asset)), mimeType: asset.mime_type };
  }

  private uploadDir(token: string) {
    if (!/^[a-f0-9-]{36}$/.test(token)) throw new Error("invalid_sealed_upload_token");
    return join(this.dataDir, "sealed", "uploads", token);
  }

  private taskPath(taskId: string) {
    return join(this.dataDir, "sealed", "tasks", assertSafeId(taskId), "evaluation.json");
  }

  private blobPath(asset: Pick<SealedAsset, "key" | "mime_type">) {
    return join(this.dataDir, "sealed", "blobs", "sha256", `${asset.key}.${mimeExtension[asset.mime_type]}`);
  }

  private async consumeUpload(token: string): Promise<SealedAsset> {
    const directory = this.uploadDir(token);
    const metadata = JSON.parse(await readFile(join(directory, "metadata.json"), "utf8")) as StagedUpload;
    if (metadata.token !== token || Date.parse(metadata.expires_at) < Date.now()) throw new Error("sealed_upload_token_expired");
    const bytes = await readFile(join(directory, "blob"));
    const key = createHash("sha256").update(bytes).digest("hex");
    const asset: SealedAsset = { key, mime_type: metadata.mime_type, original_name: metadata.original_name };
    const path = this.blobPath(asset);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await atomicWrite(path, bytes);
    await rm(directory, { recursive: true, force: true });
    return asset;
  }

  private async readSpec(taskId: string): Promise<SealedTaskSpec | undefined> {
    try {
      return JSON.parse(await readFile(this.taskPath(taskId), "utf8")) as SealedTaskSpec;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
}
