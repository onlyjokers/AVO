import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AgentToolbox } from "@avo/core";
import sharp from "sharp";

export const SVG_ENGINE_REVISION = "svg-mcp@0749c84153431f36803ec12034d64f390e2bca91";
export const SVG_OPERATIONS = [
  "add_rect", "add_circle", "add_ellipse", "add_polygon", "add_path",
  "edit_rect", "edit_circle", "edit_ellipse", "edit_polygon", "edit_path",
  "add_text", "edit_text", "create_group", "create_layer", "set_layer_state",
  "translate_node", "rotate_node", "scale_node", "set_transform", "delete_node",
  "define_linear_gradient", "define_radial_gradient", "define_clip", "define_mask",
  "apply_clip", "apply_mask", "apply_blur", "apply_color_matrix", "apply_color_overlay",
  "apply_blend", "apply_component_transfer", "apply_outer_glow", "clear_effects",
  "add_image",
] as const;

type ToolResult = { content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; structuredContent?: unknown; isError?: boolean };
type ToolDefinition = { name: string; description?: string; inputSchema: Record<string, unknown> };
export interface SvgEngine {
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  tools(): Promise<ToolDefinition[]>;
  close(): Promise<void>;
}
type DocumentRecord = {
  id: string;
  run_id: string;
  revision: number;
  width: number;
  height: number;
  parent_artifact_id: string;
  source_artifact_ids: string[];
  operations: string[];
  remote_id?: string;
};

const safeId = (id: string) => {
  if (!/^[a-zA-Z0-9_-]{1,150}$/.test(id)) throw new Error("invalid_svg_document_id");
  return id;
};
const resultValue = (result: ToolResult): unknown => {
  const text = result.content?.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n") ?? "";
  if (result.isError) throw new Error(`svg_engine_error:${text.slice(0, 1_500)}`);
  if (result.structuredContent !== undefined) {
    const structured = result.structuredContent as Record<string, unknown>;
    return structured && typeof structured === "object" && "result" in structured ? structured.result : structured;
  }
  try { return JSON.parse(text) as unknown; } catch { return text; }
};

// Only geometry/paint crosses this boundary. Files and URLs are resolved by AVO's allowed image pool.
export const validateSvgParameters = (value: unknown, depth = 0): void => {
  if (depth > 12) throw new Error("svg_parameters_too_deep");
  if (typeof value === "string") {
    if (value.length > 12_000 || /(?:https?:|file:|data:|ftp:|javascript:|@import|<!DOCTYPE|<!ENTITY)/i.test(value)
      || /url\((?!#[a-zA-Z0-9_-]+\))/i.test(value)) throw new Error("svg_external_resource_forbidden");
  } else if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > 100_000) throw new Error("invalid_svg_number");
  } else if (Array.isArray(value)) {
    if (value.length > 256) throw new Error("svg_array_too_large");
    value.forEach((item) => validateSvgParameters(item, depth + 1));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (["path", "href", "data_base64", "document_id", "backend", "svg", "__proto__", "constructor", "prototype"].includes(key)) {
        throw new Error("svg_resource_argument_forbidden");
      }
      validateSvgParameters(item, depth + 1);
    }
  }
};

export class SvgEditor {
  private readonly engines = new Map<string, Promise<SvgEngine>>();
  private readonly documents = new Map<string, DocumentRecord>();

  constructor(private readonly options: {
    dataDir: string;
    command: string;
    factory?: (runId: string) => Promise<SvgEngine>;
  }) {}

  private async engine(runId: string) {
    let engine = this.engines.get(runId);
    if (!engine) {
      engine = this.options.factory ? this.options.factory(runId) : this.startEngine(runId);
      this.engines.set(runId, engine);
      void engine.catch(() => this.engines.delete(runId));
    }
    return engine;
  }

  private async startEngine(runId: string): Promise<SvgEngine> {
    const workspace = join(this.options.dataDir, "runs", safeId(runId), "svg-runtime");
    await mkdir(workspace, { recursive: true });
    const client = new Client({ name: "avo-svg-editor", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: this.options.command,
      args: [],
      cwd: workspace,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: workspace, LANG: "en_US.UTF-8", PYTHONUNBUFFERED: "1" },
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => {});
    try { await client.connect(transport); }
    catch (error) { await transport.close(); throw new Error(`svg_engine_unavailable:${(error as Error).message}`); }
    return {
      call: (name, args) => client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 }) as Promise<ToolResult>,
      tools: async () => (await client.listTools()).tools as ToolDefinition[],
      close: () => client.close(),
    };
  }

  private directory(runId: string, documentId: string) {
    return join(this.options.dataDir, "runs", safeId(runId), "svg-documents", safeId(documentId));
  }

  private assertEnabled(tools: AgentToolbox) {
    if (!tools.getRunSnapshot().config.experimental_features?.svg_editing) throw new Error("svg_editing_disabled");
  }

  private async allowedImage(tools: AgentToolbox, artifactId: string) {
    const image = (await tools.listImagePool()).find((item) => item.artifactId === artifactId);
    if (!image) throw new Error("image_not_in_allowed_pool");
    const bytes = await readFile(image.path);
    const metadata = await sharp(bytes).metadata();
    const mime = metadata.format === "jpeg" ? "image/jpeg" : metadata.format === "webp" ? "image/webp" : "image/png";
    return { bytes, metadata, mime };
  }

  async capabilities(tools: AgentToolbox, name?: string) {
    this.assertEnabled(tools);
    const available = (await (await this.engine(tools.getRunSnapshot().id)).tools())
      .filter((item) => (SVG_OPERATIONS as readonly string[]).includes(item.name));
    if (name) {
      const definition = available.find((item) => item.name === name);
      if (!definition) throw new Error("svg_operation_not_allowed");
      const definitionCopy = structuredClone(definition);
      const properties = definitionCopy.inputSchema.properties as Record<string, unknown> | undefined;
      if (properties) {
        for (const key of ["document_id", "path", "href", "data_base64", "mime"]) delete properties[key];
        if (name === "add_image") properties.artifact_id = { type: "string", description: "An artifact ID in this Run's public image pool." };
      }
      return definitionCopy;
    }
    return {
      engine: SVG_ENGINE_REVISION,
      operations: available.map((item) => ({ name: item.name, description: item.description?.split("\n")[0] })),
      instructions: "Use avo_svg_tools(operation) for its exact parameters. No filesystem, URL or hidden-reference access. Same RGB curve through apply_component_transfer(table_values); not a neural segmentation or generative editor. Shapes/gradients can form masks. Finalize produces an ordinary candidate requiring view and evaluation.",
    };
  }

  async open(tools: AgentToolbox, parentArtifactId: string) {
    this.assertEnabled(tools);
    const run = tools.getRunSnapshot();
    if (run.parent_selection?.artifact_id !== parentArtifactId) throw new Error("svg_requires_explicit_matching_parent");
    const sourceId = run.lineage_nodes.find((node) => node.kind === "seed")?.artifact_id;
    if (!sourceId) throw new Error("svg_source_missing");
    const source = await this.allowedImage(tools, sourceId);
    const dimensions = source.metadata;
    const width = dimensions.width!, height = dimensions.height!;
    if (!width || !height || width * height > 40_000_000) throw new Error("svg_canvas_dimensions_invalid");
    const engine = await this.engine(run.id);
    const parent = run.drafts.find((draft) => draft.artifact_id === parentArtifactId && draft.svg_edit);
    let remoteId: string;
    let sources = [parentArtifactId];
    if (parent?.svg_edit) {
      const svg = await readFile(join(this.directory(run.id, parent.svg_edit.document_id), `${parent.svg_edit.revision}.svg`), "utf8");
      remoteId = (resultValue(await engine.call("import_svg", { svg })) as { document_id: string }).document_id;
      sources = [...new Set([parentArtifactId, ...parent.svg_edit.source_artifact_ids])];
    } else {
      remoteId = (resultValue(await engine.call("create_document", { width, height })) as { document_id: string }).document_id;
      const image = await this.allowedImage(tools, parentArtifactId);
      resultValue(await engine.call("add_image", {
        document_id: remoteId, x: 0, y: 0, width, height, name: "base_image",
        data_base64: image.bytes.toString("base64"), mime: image.mime,
        preserve_aspect_ratio: "none", themed: false,
      }));
    }
    if (!remoteId) throw new Error("svg_document_id_missing");
    const record: DocumentRecord = {
      id: `svg-${randomUUID()}`, run_id: run.id, revision: 0, width, height,
      parent_artifact_id: parentArtifactId, source_artifact_ids: sources, operations: [], remote_id: remoteId,
    };
    this.documents.set(`${run.id}:${record.id}`, record);
    await this.save(record, engine);
    return { document_id: record.id, revision: record.revision, width, height, outline: resultValue(await engine.call("outline", { document_id: remoteId, depth: 3 })) };
  }

  private async get(tools: AgentToolbox, documentId: string): Promise<{ record: DocumentRecord; engine: SvgEngine }> {
    this.assertEnabled(tools);
    const runId = tools.getRunSnapshot().id;
    const key = `${runId}:${safeId(documentId)}`;
    let record = this.documents.get(key);
    const engine = await this.engine(runId);
    if (!record) {
      record = JSON.parse(await readFile(join(this.directory(runId, documentId), "document.json"), "utf8")) as DocumentRecord;
      if (record.run_id !== runId || record.id !== documentId) throw new Error("svg_document_run_mismatch");
      const svg = await readFile(join(this.directory(runId, documentId), `${record.revision}.svg`), "utf8");
      record.remote_id = (resultValue(await engine.call("import_svg", { svg })) as { document_id: string }).document_id;
      this.documents.set(key, record);
    }
    return { record, engine };
  }

  private async save(record: DocumentRecord, engine: SvgEngine) {
    const svg = resultValue(await engine.call("export_svg", { document_id: record.remote_id }));
    if (typeof svg !== "string" || !svg.includes("<svg")) throw new Error("svg_export_invalid");
    if (Buffer.byteLength(svg) > 100 * 1024 * 1024) throw new Error("svg_document_too_large");
    const directory = this.directory(record.run_id, record.id);
    await mkdir(directory, { recursive: true });
    const revision = record.revision + 1;
    await writeFile(join(directory, `${revision}.svg`), svg, { flag: "wx" });
    const { remote_id: _remote, ...persisted } = record;
    const temporary = join(directory, `${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify({ ...persisted, revision }));
    await rename(temporary, join(directory, "document.json"));
    record.revision = revision;
  }

  async edit(tools: AgentToolbox, documentId: string, operation: string, parameters: Record<string, unknown>) {
    if (!(SVG_OPERATIONS as readonly string[]).includes(operation)) throw new Error("svg_operation_not_allowed");
    validateSvgParameters(parameters);
    const { record, engine } = await this.get(tools, documentId);
    if (record.operations.length >= 100) throw new Error("svg_document_operation_limit");
    const args = { ...parameters, document_id: record.remote_id };
    let newSource: string | undefined;
    if (operation === "add_image") {
      const artifactId = String(parameters.artifact_id ?? "");
      const image = await this.allowedImage(tools, artifactId);
      delete (args as Record<string, unknown>).artifact_id;
      Object.assign(args, { data_base64: image.bytes.toString("base64"), mime: image.mime, themed: false });
      newSource = artifactId;
    }
    let value: unknown;
    try { value = resultValue(await engine.call(operation, args)); }
    catch (error) {
      const svg = await readFile(join(this.directory(record.run_id, record.id), `${record.revision}.svg`), "utf8");
      record.remote_id = (resultValue(await engine.call("import_svg", { svg })) as { document_id: string }).document_id;
      throw error;
    }
    record.operations.push(operation);
    if (newSource) record.source_artifact_ids = [...new Set([...record.source_artifact_ids, newSource])];
    await this.save(record, engine);
    return { document_id: record.id, revision: record.revision, operation, result: value };
  }

  async preview(tools: AgentToolbox, documentId: string) {
    const { record, engine } = await this.get(tools, documentId);
    const result = await engine.call("render_document", { document_id: record.remote_id, scale: Math.min(1, 1024 / Math.max(record.width, record.height)), backend: "resvg-py" });
    resultValue(result);
    const image = result.content?.find((item) => item.type === "image" && item.data);
    if (!image) throw new Error("svg_preview_missing");
    return { document_id: record.id, revision: record.revision, bytes_base64: image.data!, mime_type: image.mimeType ?? "image/png" };
  }

  async parentArtifact(tools: AgentToolbox, documentId: string) {
    return (await this.get(tools, documentId)).record.parent_artifact_id;
  }

  async documentState(tools: AgentToolbox, documentId: string) {
    const { record } = await this.get(tools, documentId);
    return { parent: record.parent_artifact_id, revision: record.revision, references: record.source_artifact_ids.filter((id) => id !== record.parent_artifact_id) };
  }

  async finalize(tools: AgentToolbox, documentId: string, description: string) {
    const started = Date.now();
    const { record, engine } = await this.get(tools, documentId);
    if (!record.operations.length) throw new Error("svg_edit_operation_required");
    const existing = tools.getRunSnapshot().drafts.find((draft) => draft.svg_edit?.document_id === record.id && draft.svg_edit.revision === record.revision);
    if (existing) return { artifact_id: existing.artifact_id, draft_id: existing.id, creation_method: "svg_edit", deduplicated: true, instruction: "This document revision is already a candidate. Inspect/evaluate that candidate; edit the document before finalizing another." };
    const svg = await readFile(join(this.directory(record.run_id, record.id), `${record.revision}.svg`), "utf8");
    const result = await engine.call("render_document", { document_id: record.remote_id, scale: 1, backend: "resvg-py" });
    resultValue(result);
    const image = result.content?.find((item) => item.type === "image" && item.data);
    if (!image) throw new Error("svg_render_missing");
    const artifactId = await tools.recordEditedDraft({
      bytes: Buffer.from(image.data!, "base64"), description, parentArtifactId: record.parent_artifact_id,
      edit: {
        document_id: record.id, revision: record.revision, engine_revision: SVG_ENGINE_REVISION,
        document_sha256: createHash("sha256").update(svg).digest("hex"),
        source_artifact_ids: record.source_artifact_ids, operations: record.operations,
      },
      latencyMs: Date.now() - started,
    });
    const draft = tools.getRunSnapshot().drafts.findLast((item) => item.artifact_id === artifactId);
    return { artifact_id: artifactId, draft_id: draft?.id, creation_method: "svg_edit", instruction: "Inspect this candidate with avo_view_image, then avo_evaluate_draft before further candidate production." };
  }

  async closeRun(runId: string) {
    const engine = this.engines.get(runId);
    this.engines.delete(runId);
    for (const [key, record] of this.documents) if (record.run_id === runId) this.documents.delete(key);
    if (engine) await (await engine).close();
  }
}
