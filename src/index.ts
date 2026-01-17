import "dotenv/config";

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ServerNotification,
  type ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  InMemoryTaskMessageQueue,
  InMemoryTaskStore,
} from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import { GoogleAuth } from "google-auth-library";
import {
  removeBackground,
  type Config as ImglyConfig,
} from "@imgly/background-removal-node";
import sharp from "sharp";

const DEFAULT_MODEL =
  process.env.NANO_BANANA_MODEL ?? "gemini-3-pro-image-preview";
const DEFAULT_LOCATION = process.env.VERTEX_LOCATION ?? "global";
const DEFAULT_PROJECT_ID =
  process.env.VERTEX_PROJECT_ID ??
  process.env.GOOGLE_CLOUD_PROJECT ??
  process.env.GCLOUD_PROJECT;
const DEFAULT_GCS_BUCKET = process.env.NANO_BANANA_GCS_BUCKET;
const DEFAULT_GCS_UPLOAD_PREFIX =
  process.env.NANO_BANANA_GCS_PREFIX ?? "nano-banana/refs";
const DEFAULT_OUTPUT_GCS_BUCKET =
  process.env.NANO_BANANA_OUTPUT_GCS_BUCKET ?? DEFAULT_GCS_BUCKET;
const DEFAULT_OUTPUT_GCS_PREFIX =
  process.env.NANO_BANANA_OUTPUT_GCS_PREFIX ?? "nano-banana/outputs";
const DEFAULT_OUTPUT_DIR =
  process.env.NANO_BANANA_OUTPUT_DIR ??
  path.join(os.homedir(), "nano-banana-outputs");
const DEFAULT_TRANSPARENT_PROMPT =
  "Remove the background and make it transparent. Keep the main subject unchanged. Output a transparent PNG.";
const DEFAULT_IMGLY_MODEL =
  process.env.NANO_BANANA_IMGLY_MODEL?.trim() || "medium";
const DEFAULT_IMGLY_OUTPUT_FORMAT =
  process.env.NANO_BANANA_IMGLY_OUTPUT_FORMAT?.trim() || "image/png";
const DEFAULT_IMGLY_PUBLIC_PATH =
  process.env.NANO_BANANA_IMGLY_PUBLIC_PATH?.trim();
const DEFAULT_IMGLY_OUTPUT_QUALITY = process.env
  .NANO_BANANA_IMGLY_OUTPUT_QUALITY
  ? Number(process.env.NANO_BANANA_IMGLY_OUTPUT_QUALITY)
  : undefined;
const DEFAULT_TRANSPARENCY_KEY_COLOR =
  process.env.NANO_BANANA_TRANSPARENCY_KEY_COLOR?.trim() || "#00ff00";
const DEFAULT_TRANSPARENCY_TOLERANCE = process.env
  .NANO_BANANA_TRANSPARENCY_TOLERANCE
  ? Number(process.env.NANO_BANANA_TRANSPARENCY_TOLERANCE)
  : undefined;
const DEFAULT_TRANSPARENCY_FEATHER = process.env
  .NANO_BANANA_TRANSPARENCY_FEATHER
  ? Number(process.env.NANO_BANANA_TRANSPARENCY_FEATHER)
  : 6;
const RAW_OPAQUE_BACKGROUND_COLOR =
  process.env.NANO_BANANA_OPAQUE_BACKGROUND_COLOR;
const DEFAULT_OPAQUE_BACKGROUND_COLOR =
  RAW_OPAQUE_BACKGROUND_COLOR === undefined
    ? "auto"
    : RAW_OPAQUE_BACKGROUND_COLOR.trim();
const DEFAULT_PROGRESS_INTERVAL_MS = 20000;
const DEFAULT_AUTO_TASK_4K = resolveAutoTask4k();
const DEFAULT_AUTO_TASK_TTL_MS = resolveAutoTaskTtlMs();
const PROGRESS_INTERVAL_MS = resolveProgressIntervalMs();
const pollingTasks = new Map<string, PollingTask>();
const pollingTaskTimers = new Map<string, ReturnType<typeof setTimeout>>();

type ReferenceImage = {
  mimeType: string;
  data: string;
};

type ReferenceImageUri = {
  mimeType: string;
  fileUri: string;
  displayName?: string;
};

type ReferenceImagePath = {
  path: string;
  mimeType?: string;
  displayName?: string;
  objectName?: string;
};

type ToolArgs = {
  prompt?: string;
  referenceImages?: ReferenceImage[];
  referenceImageUris?: ReferenceImageUri[];
  referenceImagePaths?: ReferenceImagePath[];
  transparencyKeyColor?: string;
  opaqueBackgroundColor?: string;
  aspectRatio?: string;
  imageSize?: string;
  includeText?: boolean;
  responseModalities?: Array<"TEXT" | "IMAGE">;
  candidateCount?: number;
  model?: string;
  location?: string;
  projectId?: string;
  gcsBucket?: string;
  gcsUploadPrefix?: string;
  outputGcsBucket?: string;
  outputGcsPrefix?: string;
  outputDir?: string;
  outputFilePrefix?: string;
};

type SourceImageInput = {
  mimeType?: string;
  data?: string;
  fileUri?: string;
  path?: string;
  displayName?: string;
};

type TransparentMethod = "gemini" | "color-key" | "checkerboard" | "imgly";

type MakeTransparentArgs = {
  sourceImage: SourceImageInput;
  method?: TransparentMethod;
  prompt?: string;
  color?: string;
  tolerance?: number;
  feather?: number;
  returnInlineData?: boolean;
  skipGcsUpload?: boolean;
  includeText?: boolean;
  responseModalities?: Array<"TEXT" | "IMAGE">;
  candidateCount?: number;
  model?: string;
  location?: string;
  projectId?: string;
  outputGcsBucket?: string;
  outputGcsPrefix?: string;
  outputDir?: string;
  outputFilePrefix?: string;
  imglyModel?: "small" | "medium" | "large";
  imglyOutputFormat?: "image/png" | "image/jpeg" | "image/webp";
  imglyOutputQuality?: number;
  imglyPublicPath?: string;
  imglyDebug?: boolean;
};

type PollingTaskArgs = {
  taskId: string;
};

type ServiceAccount = {
  client_email?: string;
  private_key?: string;
  project_id?: string;
};

type GenerateContentResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: {
          mimeType?: string;
          data?: string;
        };
      }>;
    };
  }>;
};

type ProgressReporter = {
  report: (message?: string) => void;
  startHeartbeat: (message: string) => () => void;
};

type OpaqueBackgroundSetting =
  | { mode: "auto" }
  | { mode: "fixed"; color: { r: number; g: number; b: number }; raw: string };

type PollingTaskStatus = "queued" | "working" | "completed" | "failed";

type PollingTask = {
  taskId: string;
  status: PollingTaskStatus;
  createdAt: number;
  expiresAt?: number;
  result?: CallToolResult;
};

function extensionForMimeType(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/png":
    default:
      return "png";
  }
}

let cachedServiceAccount: ServiceAccount | null = null;
let cachedAuthClient: ReturnType<GoogleAuth["getClient"]> | null = null;

function buildErrorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: `Nano Banana error: ${message}` }],
    isError: true,
  };
}

function setIfNonEmpty(
  target: Record<string, unknown>,
  key: string,
  value?: unknown
) {
  if (Array.isArray(value)) {
    if (value.length > 0) {
      target[key] = value;
    }
    return;
  }
  if (value !== undefined) {
    target[key] = value;
  }
}

function buildOutputStructuredContent(options: {
  referenceImageUris?: string[];
  outputImageUris?: string[];
  outputImageUrls?: string[];
  savedPaths?: string[];
  inlineData?: string[];
}) {
  const structuredContent: Record<string, unknown> = {};
  setIfNonEmpty(
    structuredContent,
    "referenceImageUris",
    options.referenceImageUris
  );
  setIfNonEmpty(structuredContent, "outputImageUris", options.outputImageUris);
  setIfNonEmpty(structuredContent, "outputImageUrls", options.outputImageUrls);
  setIfNonEmpty(structuredContent, "savedPaths", options.savedPaths);
  setIfNonEmpty(structuredContent, "inlineData", options.inlineData);
  return structuredContent;
}

function clearPollingTaskTimer(taskId: string) {
  const timer = pollingTaskTimers.get(taskId);
  if (timer) {
    clearTimeout(timer);
    pollingTaskTimers.delete(taskId);
  }
}

function schedulePollingTaskCleanup(task: PollingTask) {
  if (DEFAULT_AUTO_TASK_TTL_MS === null) {
    return;
  }
  clearPollingTaskTimer(task.taskId);
  task.expiresAt = Date.now() + DEFAULT_AUTO_TASK_TTL_MS;
  const timer = setTimeout(() => {
    pollingTasks.delete(task.taskId);
    pollingTaskTimers.delete(task.taskId);
  }, DEFAULT_AUTO_TASK_TTL_MS);
  pollingTaskTimers.set(task.taskId, timer);
}

function createPollingTask(): PollingTask {
  const task: PollingTask = {
    taskId: randomUUID(),
    status: "queued",
    createdAt: Date.now(),
  };
  pollingTasks.set(task.taskId, task);
  return task;
}

function setPollingTaskStatus(taskId: string, status: PollingTaskStatus) {
  const task = pollingTasks.get(taskId);
  if (!task) {
    return;
  }
  task.status = status;
}

function storePollingTaskResult(taskId: string, result: CallToolResult) {
  const task = pollingTasks.get(taskId);
  if (!task) {
    return;
  }
  task.status = result.isError ? "failed" : "completed";
  task.result = result;
  schedulePollingTaskCleanup(task);
}

function normalizeBase64(data: string): string {
  const trimmed = data.trim();
  const match = trimmed.match(/^data:[^;]+;base64,(.*)$/);
  return match ? match[1] : trimmed;
}

function normalizeGcsPrefix(prefix?: string, fallback?: string): string {
  const fallbackValue = (fallback ?? DEFAULT_GCS_UPLOAD_PREFIX).trim();
  const trimmed = (prefix ?? fallbackValue).trim();
  if (!trimmed) {
    return fallbackValue || "nano-banana/refs";
  }
  return trimmed.replace(/^\/+|\/+$/g, "");
}

function resolveLocalPath(filePath: string): string {
  const trimmed = filePath.trim();
  if (trimmed.startsWith("~" + path.sep)) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

function inferMimeTypeFromPath(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".bmp":
      return "image/bmp";
    case ".tif":
    case ".tiff":
      return "image/tiff";
    default:
      return null;
  }
}

function inferMimeTypeFromUri(fileUri: string): string | null {
  const cleaned = fileUri.split("?")[0];
  const filename = cleaned.split("/").pop() ?? cleaned;
  return inferMimeTypeFromPath(filename);
}

function clampByte(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 255) {
    return 255;
  }
  return Math.round(value);
}

function parseHexColor(input: string): { r: number; g: number; b: number } {
  const trimmed = input.trim();
  const hex = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  if (!/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(hex)) {
    throw new Error(
      `Invalid color "${input}". Use hex like #fff or #ffffff.`
    );
  }

  if (hex.length === 3) {
    const r = parseInt(hex[0] + hex[0], 16);
    const g = parseInt(hex[1] + hex[1], 16);
    const b = parseInt(hex[2] + hex[2], 16);
    return { r, g, b };
  }

  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return { r, g, b };
}

function parseGcsUri(fileUri: string): { bucket: string; objectName: string } {
  if (!fileUri.startsWith("gs://")) {
    throw new Error(`Only gs:// URIs are supported: ${fileUri}`);
  }
  const remainder = fileUri.slice("gs://".length);
  const [bucket, ...rest] = remainder.split("/");
  const objectName = rest.join("/");
  if (!bucket || !objectName) {
    throw new Error(`Invalid GCS URI: ${fileUri}`);
  }
  return { bucket, objectName };
}

function formatHexColor(color: { r: number; g: number; b: number }): string {
  const toHex = (value: number) =>
    clampByte(value).toString(16).padStart(2, "0");
  return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
}

function resolveOpaqueBackgroundSetting(
  value?: string
): OpaqueBackgroundSetting | null {
  const raw =
    value !== undefined
      ? value.trim()
      : DEFAULT_OPAQUE_BACKGROUND_COLOR?.trim();
  if (!raw) {
    return null;
  }
  const normalized = raw.toLowerCase();
  if (
    normalized === "off" ||
    normalized === "none" ||
    normalized === "false" ||
    normalized === "no" ||
    normalized === "disable" ||
    normalized === "disabled"
  ) {
    return null;
  }
  if (normalized === "auto") {
    return { mode: "auto" };
  }
  return { mode: "fixed", color: parseHexColor(raw), raw };
}

async function sampleTopLeftColor(buffer: Buffer) {
  const { data } = await sharp(buffer, { failOnError: false })
    .ensureAlpha()
    .extract({ left: 0, top: 0, width: 1, height: 1 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { r: data[0], g: data[1], b: data[2] };
}

async function resolveOpaqueBackgroundColor(
  setting: OpaqueBackgroundSetting,
  buffer: Buffer
): Promise<{ r: number; g: number; b: number }> {
  if (setting.mode === "fixed") {
    return setting.color;
  }
  return sampleTopLeftColor(buffer);
}

async function flattenToOpaque(options: {
  buffer: Buffer;
  mimeType: string;
  background: { r: number; g: number; b: number };
}) {
  if (options.mimeType === "image/jpeg") {
    return options.buffer;
  }

  const pipeline = sharp(options.buffer, { failOnError: false }).flatten({
    background: options.background,
  });

  if (options.mimeType === "image/webp") {
    return pipeline.webp().toBuffer();
  }

  return pipeline.png().toBuffer();
}

function shouldAutoTransparent(prompt?: string): boolean {
  if (!prompt) {
    return false;
  }
  const normalized = prompt.toLowerCase();
  const explicitTransparent =
    normalized.includes("transparent background") ||
    normalized.includes("transparent png") ||
    normalized.includes("transparent pngs") ||
    normalized.includes("transparent image") ||
    normalized.includes("no background") ||
    normalized.includes("remove background") ||
    normalized.includes("alpha") ||
    normalized.includes("transparency") ||
    normalized.includes("transparent");
  return explicitTransparent;
}

function buildTransparencyPrompt(originalPrompt: string, keyColor: string) {
  return [
    originalPrompt.trim(),
    "",
    `IMPORTANT: Render on a perfectly flat, solid background color ${keyColor} (exact hex).`,
    "No gradients, no textures, no shadows, no glow, no transparency.",
    `Do not use ${keyColor} anywhere in the subject.`,
    "Keep the subject fully opaque with crisp, clean edges.",
    "Leave a small margin around the subject.",
  ].join("\n");
}

async function loadServiceAccount(): Promise<ServiceAccount> {
  if (cachedServiceAccount) {
    return cachedServiceAccount;
  }

  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_JSON is required (JSON string or file path)."
    );
  }

  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    cachedServiceAccount = JSON.parse(trimmed) as ServiceAccount;
    return cachedServiceAccount;
  }

  const fileContents = await readFile(trimmed, "utf8");
  cachedServiceAccount = JSON.parse(fileContents) as ServiceAccount;
  return cachedServiceAccount;
}

async function getAuthClient() {
  if (!cachedAuthClient) {
    const serviceAccount = await loadServiceAccount();
    const auth = new GoogleAuth({
      credentials: serviceAccount,
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
    cachedAuthClient = auth.getClient();
  }

  return cachedAuthClient;
}

function resolveGcsBucket(args: ToolArgs): string | null {
  const bucket = args.gcsBucket ?? DEFAULT_GCS_BUCKET;
  const trimmed = bucket?.trim();
  return trimmed ? trimmed : null;
}

function resolveOutputGcsBucket(args: {
  outputGcsBucket?: string;
}): string | null {
  const bucket = args.outputGcsBucket ?? DEFAULT_OUTPUT_GCS_BUCKET;
  const trimmed = bucket?.trim();
  return trimmed ? trimmed : null;
}

function resolveOutputDir(outputDir?: string): string {
  const baseDir = resolveLocalPath(DEFAULT_OUTPUT_DIR);
  const trimmed = outputDir?.trim();
  if (!trimmed) {
    return baseDir;
  }
  if (trimmed.startsWith("~" + path.sep) || path.isAbsolute(trimmed)) {
    return resolveLocalPath(trimmed);
  }
  return path.resolve(baseDir, trimmed);
}

function resolveProgressIntervalMs(): number {
  const raw = process.env.NANO_BANANA_PROGRESS_INTERVAL_MS;
  if (!raw) {
    return DEFAULT_PROGRESS_INTERVAL_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_PROGRESS_INTERVAL_MS;
  }
  return parsed > 0 ? parsed : 0;
}

function resolveAutoTask4k(): boolean {
  const raw = process.env.NANO_BANANA_AUTO_TASK_4K;
  if (!raw) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return false;
}

function resolveAutoTaskTtlMs(): number | null {
  const raw = process.env.NANO_BANANA_AUTO_TASK_TTL_MS;
  if (!raw) {
    return 20 * 60 * 1000;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return 20 * 60 * 1000;
  }
  return parsed > 0 ? parsed : null;
}

function createProgressReporter(
  extra?: RequestHandlerExtra<ServerRequest, ServerNotification>
): ProgressReporter | null {
  const progressToken = extra?._meta?.progressToken;
  if (progressToken === undefined || !extra?.sendNotification) {
    return null;
  }

  let progress = 0;
  let disabled = false;

  const report = (message?: string) => {
    if (disabled) {
      return;
    }
    progress += 1;
    void extra
      .sendNotification({
        method: "notifications/progress",
        params: {
          progress,
          ...(message ? { message } : {}),
          progressToken,
        },
      })
      .catch((error) => {
        disabled = true;
        console.warn("Progress notification failed:", error);
      });
  };

  const startHeartbeat = (message: string) => {
    if (PROGRESS_INTERVAL_MS <= 0) {
      return () => {};
    }
    report(message);
    const intervalId = setInterval(() => {
      report(message);
    }, PROGRESS_INTERVAL_MS);
    return () => {
      clearInterval(intervalId);
    };
  };

  return { report, startHeartbeat };
}

function normalizeImageSize(value?: string): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.toUpperCase();
}

function shouldAutoTaskFor4k(
  toolName: string,
  args?: ToolArgs | null
): boolean {
  if (!DEFAULT_AUTO_TASK_4K) {
    return false;
  }
  if (toolName !== "nano_banana_generate_image") {
    return false;
  }
  const imageSize = normalizeImageSize(args?.imageSize);
  return imageSize === "4K";
}

async function resolveProjectId(): Promise<string> {
  if (DEFAULT_PROJECT_ID) {
    return DEFAULT_PROJECT_ID;
  }

  const serviceAccount = await loadServiceAccount();
  if (serviceAccount.project_id) {
    return serviceAccount.project_id;
  }

  throw new Error(
    "Project ID not found. Set VERTEX_PROJECT_ID or include project_id in the service account JSON."
  );
}

async function uploadFileToGcs(options: {
  bucket: string;
  objectName: string;
  mimeType: string;
  filePath: string;
}) {
  const fileBuffer = await readFile(options.filePath);
  await uploadBufferToGcs({
    bucket: options.bucket,
    objectName: options.objectName,
    mimeType: options.mimeType,
    data: fileBuffer,
  });
}

async function uploadBufferToGcs(options: {
  bucket: string;
  objectName: string;
  mimeType: string;
  data: Buffer;
}) {
  const client = await getAuthClient();
  const encodedObjectName = encodeURIComponent(options.objectName);
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${options.bucket}/o?uploadType=media&name=${encodedObjectName}`;

  await client.request({
    url,
    method: "POST",
    data: options.data,
    headers: {
      "Content-Type": options.mimeType,
    },
  });
}

async function downloadBufferFromGcs(options: {
  bucket: string;
  objectName: string;
}): Promise<Buffer> {
  const client = await getAuthClient();
  const encodedObjectName = encodeURIComponent(options.objectName);
  const url = `https://storage.googleapis.com/storage/v1/b/${options.bucket}/o/${encodedObjectName}?alt=media`;

  const response = await client.request({
    url,
    method: "GET",
    responseType: "arraybuffer",
  });

  return Buffer.from(response.data as ArrayBuffer);
}

async function resolveSourceImageBuffer(
  sourceImage: SourceImageInput
): Promise<{ buffer: Buffer; mimeType: string }> {
  if (sourceImage.data) {
    const mimeType = sourceImage.mimeType?.trim();
    if (!mimeType) {
      throw new Error("sourceImage.mimeType is required for base64 data.");
    }
    return {
      buffer: Buffer.from(normalizeBase64(sourceImage.data), "base64"),
      mimeType,
    };
  }

  if (sourceImage.path) {
    const resolvedPath = resolveLocalPath(sourceImage.path);
    const mimeType =
      sourceImage.mimeType ?? inferMimeTypeFromPath(resolvedPath);
    if (!mimeType) {
      throw new Error(
        `MIME type not provided and could not be inferred for ${resolvedPath}.`
      );
    }
    return {
      buffer: await readFile(resolvedPath),
      mimeType,
    };
  }

  if (sourceImage.fileUri) {
    const mimeType =
      sourceImage.mimeType ?? inferMimeTypeFromUri(sourceImage.fileUri);
    if (!mimeType) {
      throw new Error(
        `MIME type not provided and could not be inferred for ${sourceImage.fileUri}.`
      );
    }
    const { bucket, objectName } = parseGcsUri(sourceImage.fileUri);
    return {
      buffer: await downloadBufferFromGcs({ bucket, objectName }),
      mimeType,
    };
  }

  throw new Error("sourceImage must include data, path, or fileUri.");
}

async function buildGeminiArgsForTransparency(
  args: MakeTransparentArgs
): Promise<ToolArgs> {
  const prompt =
    args.prompt?.trim() || DEFAULT_TRANSPARENT_PROMPT;
  const toolArgs: ToolArgs = {
    prompt,
    includeText: args.includeText,
    responseModalities: args.responseModalities,
    candidateCount: args.candidateCount,
    model: args.model,
    location: args.location,
    projectId: args.projectId,
    outputGcsBucket: args.outputGcsBucket,
    outputGcsPrefix: args.outputGcsPrefix,
    outputDir: args.outputDir,
    outputFilePrefix: args.outputFilePrefix,
  };

  const sourceImage = args.sourceImage;
  if (sourceImage.data) {
    if (!sourceImage.mimeType?.trim()) {
      throw new Error("sourceImage.mimeType is required for base64 data.");
    }
    toolArgs.referenceImages = [
      {
        mimeType: sourceImage.mimeType.trim(),
        data: sourceImage.data,
      },
    ];
    return toolArgs;
  }

  if (sourceImage.path) {
    const resolvedPath = resolveLocalPath(sourceImage.path);
    const mimeType =
      sourceImage.mimeType ?? inferMimeTypeFromPath(resolvedPath);
    if (!mimeType) {
      throw new Error(
        `MIME type not provided and could not be inferred for ${resolvedPath}.`
      );
    }
    const buffer = await readFile(resolvedPath);
    toolArgs.referenceImages = [
      {
        mimeType,
        data: buffer.toString("base64"),
      },
    ];
    return toolArgs;
  }

  if (sourceImage.fileUri) {
    const mimeType =
      sourceImage.mimeType ?? inferMimeTypeFromUri(sourceImage.fileUri);
    if (!mimeType) {
      throw new Error(
        `MIME type not provided and could not be inferred for ${sourceImage.fileUri}.`
      );
    }
    toolArgs.referenceImageUris = [
      {
        mimeType,
        fileUri: sourceImage.fileUri,
        ...(sourceImage.displayName
          ? { displayName: sourceImage.displayName }
          : {}),
      },
    ];
    return toolArgs;
  }

  throw new Error("sourceImage must include data, path, or fileUri.");
}

function extractImagesAndTexts(response: GenerateContentResponse) {
  const images: Array<{ mimeType: string; data: string }> = [];
  const texts: string[] = [];

  for (const candidate of response.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      if (part.text) {
        texts.push(part.text);
      }
      if (part.inlineData?.data) {
        images.push({
          mimeType: part.inlineData.mimeType ?? "image/png",
          data: part.inlineData.data,
        });
      }
    }
  }

  return { images, texts };
}

async function applyColorKeyTransparency(options: {
  buffer: Buffer;
  color?: { r: number; g: number; b: number };
  tolerance?: number;
  feather?: number;
}): Promise<Buffer> {
  const image = sharp(options.buffer, { failOnError: false });
  const { data, info } = await image
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const baseColor = options.color ?? {
    r: data[0],
    g: data[1],
    b: data[2],
  };

  return applyMultiColorKeyToRaw({
    data,
    info,
    colors: [baseColor],
    tolerance: options.tolerance,
    feather: options.feather,
  });
}

function detectCheckerboardColorsFromBorder(
  data: Buffer,
  info: { width: number; height: number; channels: number },
  options?: {
    sampleStep?: number;
    quantizeStep?: number;
    maxColors?: number;
  }
) {
  const width = info.width;
  const height = info.height;
  const channels = info.channels;
  const sampleStep =
    options?.sampleStep ??
    Math.max(1, Math.round(Math.min(width, height) / 64));
  const quantizeStep = Math.max(1, options?.quantizeStep ?? 8);
  const maxColors = Math.max(1, options?.maxColors ?? 2);
  const samples: Array<{ r: number; g: number; b: number }> = [];
  const counts = new Map<
    string,
    { r: number; g: number; b: number; count: number }
  >();
  let sampleCount = 0;

  const addSample = (r: number, g: number, b: number) => {
    samples.push({ r, g, b });
    const qr = clampByte(Math.round(r / quantizeStep) * quantizeStep);
    const qg = clampByte(Math.round(g / quantizeStep) * quantizeStep);
    const qb = clampByte(Math.round(b / quantizeStep) * quantizeStep);
    const key = `${qr},${qg},${qb}`;
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(key, { r: qr, g: qg, b: qb, count: 1 });
    }
    sampleCount += 1;
  };

  const index = (x: number, y: number) => (y * width + x) * channels;

  for (let x = 0; x < width; x += sampleStep) {
    let idx = index(x, 0);
    addSample(data[idx], data[idx + 1], data[idx + 2]);
    idx = index(x, height - 1);
    addSample(data[idx], data[idx + 1], data[idx + 2]);
  }

  for (let y = 0; y < height; y += sampleStep) {
    let idx = index(0, y);
    addSample(data[idx], data[idx + 1], data[idx + 2]);
    idx = index(width - 1, y);
    addSample(data[idx], data[idx + 1], data[idx + 2]);
  }

  const sorted = Array.from(counts.values()).sort(
    (a, b) => b.count - a.count
  );
  const colors = sorted
    .slice(0, maxColors)
    .map((entry) => ({ r: entry.r, g: entry.g, b: entry.b }));
  const topSamples = sorted
    .slice(0, maxColors)
    .reduce((sum, entry) => sum + entry.count, 0);
  const coverage = sampleCount > 0 ? topSamples / sampleCount : 0;

  return { colors, sampleCount, coverage, samples };
}

async function applyAutoKeyTransparency(options: {
  buffer: Buffer;
  fallbackColor?: { r: number; g: number; b: number };
  tolerance?: number;
  feather?: number;
  sampleStep?: number;
  quantizeStep?: number;
  maxColors?: number;
}): Promise<{
  outputBuffer: Buffer;
  colors: Array<{ r: number; g: number; b: number }>;
  coverage: number;
  usedFallback: boolean;
}> {
  const image = sharp(options.buffer, { failOnError: false });
  const { data, info } = await image
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { colors, coverage, samples } = detectCheckerboardColorsFromBorder(
    data,
    info,
    {
      sampleStep: options.sampleStep,
      quantizeStep: options.quantizeStep,
      maxColors: options.maxColors,
    }
  );

  let selectedColors = colors;
  let usedFallback = false;
  if (coverage < 0.5 || selectedColors.length === 0) {
    if (options.fallbackColor) {
      selectedColors = [options.fallbackColor];
      usedFallback = true;
    } else {
      throw new Error("Failed to detect background colors for transparency.");
    }
  }

  let tolerance = options.tolerance;
  if (typeof tolerance !== "number") {
    const distances = samples.map((sample) => {
      let minDistSq = Number.POSITIVE_INFINITY;
      for (const color of selectedColors) {
        const dr = sample.r - color.r;
        const dg = sample.g - color.g;
        const db = sample.b - color.b;
        const distSq = dr * dr + dg * dg + db * db;
        if (distSq < minDistSq) {
          minDistSq = distSq;
        }
      }
      return minDistSq;
    });
    distances.sort((a, b) => a - b);
    const percentileIndex = Math.floor(distances.length * 0.9);
    const percentile =
      distances.length > 0 ? distances[percentileIndex] : 0;
    tolerance = clampByte(Math.ceil(Math.sqrt(percentile)) + 6);
  }

  const outputBuffer = await applyMultiColorKeyToRaw({
    data,
    info,
    colors: selectedColors,
    tolerance,
    feather: options.feather,
  });

  return { outputBuffer, colors: selectedColors, coverage, usedFallback };
}

async function applyMultiColorKeyToRaw(options: {
  data: Buffer;
  info: { width: number; height: number; channels: number };
  colors: Array<{ r: number; g: number; b: number }>;
  tolerance?: number;
  feather?: number;
}): Promise<Buffer> {
  if (options.colors.length === 0) {
    throw new Error("No background colors detected for transparency.");
  }

  const tolerance = clampByte(options.tolerance ?? 12);
  const feather = clampByte(options.feather ?? 0);
  const toleranceSq = tolerance * tolerance;
  const featherLimit = tolerance + feather;
  const featherLimitSq = featherLimit * featherLimit;

  const data = options.data;
  const channels = options.info.channels;

  for (let i = 0; i < data.length; i += channels) {
    let minDistSq = Number.POSITIVE_INFINITY;
    for (const color of options.colors) {
      const dr = data[i] - color.r;
      const dg = data[i + 1] - color.g;
      const db = data[i + 2] - color.b;
      const distSq = dr * dr + dg * dg + db * db;
      if (distSq < minDistSq) {
        minDistSq = distSq;
      }
    }

    const originalAlpha = data[i + 3];
    let alphaFactor = 1;
    if (minDistSq <= toleranceSq) {
      alphaFactor = 0;
    } else if (feather > 0 && minDistSq < featherLimitSq) {
      const dist = Math.sqrt(minDistSq);
      alphaFactor = (dist - tolerance) / feather;
    }

    data[i + 3] = clampByte(originalAlpha * alphaFactor);
  }

  const rawChannels = options.info.channels as 1 | 2 | 3 | 4;
  return sharp(data, {
    raw: {
      width: options.info.width,
      height: options.info.height,
      channels: rawChannels,
    },
  })
    .png()
    .toBuffer();
}

async function applyCheckerboardTransparency(options: {
  buffer: Buffer;
  tolerance?: number;
  feather?: number;
  sampleStep?: number;
  quantizeStep?: number;
  maxColors?: number;
}): Promise<{
  outputBuffer: Buffer;
  colors: Array<{ r: number; g: number; b: number }>;
  coverage: number;
}> {
  const image = sharp(options.buffer, { failOnError: false });
  const { data, info } = await image
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { colors, coverage } = detectCheckerboardColorsFromBorder(
    data,
    info,
    {
      sampleStep: options.sampleStep,
      quantizeStep: options.quantizeStep,
      maxColors: options.maxColors,
    }
  );

  const outputBuffer = await applyMultiColorKeyToRaw({
    data,
    info,
    colors,
    tolerance: options.tolerance,
    feather: options.feather,
  });

  return { outputBuffer, colors, coverage };
}

async function persistOutputImages(options: {
  images: Array<{ mimeType: string; data: Buffer }>;
  outputFilePrefix?: string;
  outputGcsBucket?: string | null;
  outputGcsPrefix?: string;
  outputDir?: string;
  requireGcsUpload?: boolean;
  skipGcsUpload?: boolean;
}) {
  const outputTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPrefix = options.outputFilePrefix?.trim() || "nano-banana";
  const outputBucket = options.outputGcsBucket;
  const shouldUpload = !(options.skipGcsUpload ?? false);
  const uploadedOutputUris: string[] = [];
  const uploadedOutputUrls: string[] = [];

  if (shouldUpload) {
    if (!outputBucket && options.requireGcsUpload) {
      throw new Error(
        "Output GCS bucket not set. Provide outputGcsBucket or set NANO_BANANA_OUTPUT_GCS_BUCKET (or NANO_BANANA_GCS_BUCKET)."
      );
    }

    if (outputBucket) {
      const outputGcsPrefix = normalizeGcsPrefix(
        options.outputGcsPrefix,
        DEFAULT_OUTPUT_GCS_PREFIX
      );

      for (let i = 0; i < options.images.length; i += 1) {
        const image = options.images[i];
        const ext = extensionForMimeType(image.mimeType);
        const filename = `${outputPrefix}-${outputTimestamp}-${i + 1}.${ext}`;
        const objectName = `${outputGcsPrefix}/${filename}`;
        await uploadBufferToGcs({
          bucket: outputBucket,
          objectName,
          mimeType: image.mimeType,
          data: image.data,
        });
        uploadedOutputUris.push(`gs://${outputBucket}/${objectName}`);
        uploadedOutputUrls.push(
          `https://storage.googleapis.com/${outputBucket}/${objectName}`
        );
      }
    }
  }

  const resolvedOutputDir = resolveOutputDir(options.outputDir);
  await mkdir(resolvedOutputDir, { recursive: true });
  const savedPaths: string[] = [];

  for (let i = 0; i < options.images.length; i += 1) {
    const image = options.images[i];
    const ext = extensionForMimeType(image.mimeType);
    const filename = `${outputPrefix}-${outputTimestamp}-${i + 1}.${ext}`;
    const outputPath = path.join(resolvedOutputDir, filename);
    await writeFile(outputPath, image.data);
    savedPaths.push(outputPath);
  }

  return { uploadedOutputUris, uploadedOutputUrls, savedPaths };
}

async function generateImage(args: ToolArgs): Promise<{
  response: GenerateContentResponse;
  uploadedUris: string[];
}> {
  const projectId = args.projectId ?? (await resolveProjectId());
  const location = (args.location ?? DEFAULT_LOCATION).trim();
  const model = args.model ?? DEFAULT_MODEL;

  const parts: Array<{
    text?: string;
    inlineData?: ReferenceImage;
    fileData?: ReferenceImageUri;
  }> = [];
  const uploadedUris: string[] = [];
  if (args.prompt?.trim()) {
    parts.push({ text: args.prompt.trim() });
  }
  if (args.referenceImages?.length) {
    for (const image of args.referenceImages) {
      parts.push({
        inlineData: {
          mimeType: image.mimeType,
          data: normalizeBase64(image.data),
        },
      });
    }
  }
  if (args.referenceImageUris?.length) {
    for (const image of args.referenceImageUris) {
      parts.push({
        fileData: {
          mimeType: image.mimeType,
          fileUri: image.fileUri,
          ...(image.displayName ? { displayName: image.displayName } : {}),
        },
      });
    }
  }
  if (args.referenceImagePaths?.length) {
    const bucket = resolveGcsBucket(args);
    if (!bucket) {
      throw new Error(
        "GCS bucket not set. Provide gcsBucket or set NANO_BANANA_GCS_BUCKET."
      );
    }
    const prefix = normalizeGcsPrefix(
      args.gcsUploadPrefix,
      DEFAULT_GCS_UPLOAD_PREFIX
    );
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

    for (let i = 0; i < args.referenceImagePaths.length; i += 1) {
      const image = args.referenceImagePaths[i];
      const resolvedPath = resolveLocalPath(image.path);
      const mimeType =
        image.mimeType ?? inferMimeTypeFromPath(resolvedPath);
      if (!mimeType) {
        throw new Error(
          `MIME type not provided and could not be inferred for ${resolvedPath}.`
        );
      }

      const baseName = path.basename(resolvedPath) || `image-${i + 1}`;
      const objectName =
        image.objectName?.trim() ||
        `${prefix}/${timestamp}-${i + 1}-${baseName}`;

      await uploadFileToGcs({
        bucket,
        objectName,
        mimeType,
        filePath: resolvedPath,
      });

      const fileUri = `gs://${bucket}/${objectName}`;
      uploadedUris.push(fileUri);
      parts.push({
        fileData: {
          mimeType,
          fileUri,
          ...(image.displayName ? { displayName: image.displayName } : {}),
        },
      });
    }
  }

  if (parts.length === 0) {
    throw new Error(
      "Provide a prompt or at least one reference image (inline or GCS URI)."
    );
  }

  const responseModalities =
    args.responseModalities ??
    (args.includeText ? ["TEXT", "IMAGE"] : ["IMAGE"]);

  const generationConfig: Record<string, unknown> = {
    responseModalities,
  };

  if (typeof args.candidateCount === "number") {
    generationConfig.candidateCount = args.candidateCount;
  }

  if (args.aspectRatio || args.imageSize) {
    generationConfig.imageConfig = {
      ...(args.aspectRatio ? { aspectRatio: args.aspectRatio } : {}),
      ...(args.imageSize ? { imageSize: args.imageSize } : {}),
    };
  }

  const requestBody = {
    contents: [
      {
        role: "user",
        parts,
      },
    ],
    generationConfig,
  };

  const apiHost =
    location === "global"
      ? "aiplatform.googleapis.com"
      : `${location}-aiplatform.googleapis.com`;
  const url = `https://${apiHost}/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:generateContent`;

  const client = await getAuthClient();
  const response = await client.request({
    url,
    method: "POST",
    data: requestBody,
  });

  return {
    response: response.data as GenerateContentResponse,
    uploadedUris,
  };
}

async function handleGenerateImage(
  args: ToolArgs,
  progress?: ProgressReporter | null
): Promise<CallToolResult> {
  const stopHeartbeat = progress?.startHeartbeat("Generating image...");
  try {
    if (shouldAutoTransparent(args.prompt)) {
      return await handleGenerateImageWithTransparency(args, progress);
    }

    progress?.report("Requesting image generation.");
    const result = await generateImage(args);
    const { images, texts } = extractImagesAndTexts(result.response);
    const opaqueSetting = resolveOpaqueBackgroundSetting(
      args.opaqueBackgroundColor
    );

    const content: Array<{ type: "text"; text: string }> = [];
    const structuredContent = buildOutputStructuredContent({
      referenceImageUris: result.uploadedUris,
    });

    content.push({
      type: "text",
      text: `Generated ${images.length} image(s) with model ${
        args.model ?? DEFAULT_MODEL
      }.`,
    });

    if (args.includeText && texts.length > 0) {
      content.push({ type: "text", text: texts.join("\n") });
    }

    if (result.uploadedUris.length > 0) {
      content.push({
        type: "text",
        text: `Uploaded ${result.uploadedUris.length} reference image(s) to:\n${result.uploadedUris.join(
          "\n"
        )}`,
      });
    }

    if (images.length > 0) {
      progress?.report("Persisting generated images.");
      const outputImages = await Promise.all(
        images.map(async (image) => {
          const rawBuffer = Buffer.from(
            normalizeBase64(image.data),
            "base64"
          );
          if (!opaqueSetting) {
            return { mimeType: image.mimeType, data: rawBuffer };
          }

          const background = await resolveOpaqueBackgroundColor(
            opaqueSetting,
            rawBuffer
          );
          const data = await flattenToOpaque({
            buffer: rawBuffer,
            mimeType: image.mimeType,
            background,
          });
          return { mimeType: image.mimeType, data };
        })
      );
      const outputBucket = resolveOutputGcsBucket(args);
      const { uploadedOutputUris, uploadedOutputUrls, savedPaths } =
        await persistOutputImages({
          images: outputImages,
          outputFilePrefix: args.outputFilePrefix,
          outputGcsBucket: outputBucket,
          outputGcsPrefix: args.outputGcsPrefix,
          outputDir: args.outputDir,
          requireGcsUpload: true,
        });

      content.push({
        type: "text",
        text: `Uploaded ${uploadedOutputUris.length} generated image(s) to:\n${uploadedOutputUris.join(
          "\n"
        )}`,
      });
      content.push({
        type: "text",
        text: `HTTP URL(s) (requires bucket access):\n${uploadedOutputUrls.join(
          "\n"
        )}`,
      });
      content.push({
        type: "text",
        text: `Saved ${savedPaths.length} image(s) to:\n${savedPaths.join("\n")}`,
      });

      Object.assign(
        structuredContent,
        buildOutputStructuredContent({
          outputImageUris: uploadedOutputUris,
          outputImageUrls: uploadedOutputUrls,
          savedPaths,
        })
      );
    }

    if (images.length === 0 && texts.length > 0) {
      content.push({
        type: "text",
        text: texts.join("\n"),
      });
    }

    return Object.keys(structuredContent).length
      ? { content, structuredContent }
      : { content };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Nano Banana error: ${message}` }],
      isError: true,
    };
  } finally {
    stopHeartbeat?.();
  }
}

async function handleGenerateImageWithTransparency(
  args: ToolArgs,
  progress?: ProgressReporter | null
): Promise<CallToolResult> {
  const content: Array<{ type: "text"; text: string }> = [];
  try {
    const keyColor =
      args.transparencyKeyColor?.trim() || DEFAULT_TRANSPARENCY_KEY_COLOR;
    const transparencyPrompt = buildTransparencyPrompt(
      args.prompt ?? "",
      keyColor
    );

    progress?.report("Requesting transparency-ready image.");
    const generateArgs: ToolArgs = {
      ...args,
      prompt: transparencyPrompt,
    };
    const result = await generateImage(generateArgs);
    const { images, texts } = extractImagesAndTexts(result.response);
    const structuredContent = buildOutputStructuredContent({
      referenceImageUris: result.uploadedUris,
    });

    content.push({
      type: "text",
      text: `Generated ${images.length} image(s) with transparency-ready background.`,
    });

    if (args.includeText && texts.length > 0) {
      content.push({ type: "text", text: texts.join("\n") });
    }

    if (result.uploadedUris.length > 0) {
      content.push({
        type: "text",
        text: `Uploaded ${result.uploadedUris.length} reference image(s) to:\n${result.uploadedUris.join(
          "\n"
        )}`,
      });
    }

    if (images.length > 0) {
      progress?.report("Applying transparency.");
      const parsedKeyColor = parseHexColor(keyColor);
      const outputImages: Array<{ mimeType: string; data: Buffer }> = [];

      for (const image of images) {
        const rawBuffer = Buffer.from(normalizeBase64(image.data), "base64");
        const { outputBuffer } = await applyAutoKeyTransparency({
          buffer: rawBuffer,
          fallbackColor: parsedKeyColor,
          tolerance: DEFAULT_TRANSPARENCY_TOLERANCE,
          feather: DEFAULT_TRANSPARENCY_FEATHER,
          sampleStep: 8,
          quantizeStep: 6,
          maxColors: 2,
        });
        outputImages.push({
          mimeType: "image/png",
          data: outputBuffer,
        });
      }

      const outputBucket = resolveOutputGcsBucket(args);
      const { uploadedOutputUris, uploadedOutputUrls, savedPaths } =
        await persistOutputImages({
          images: outputImages,
          outputFilePrefix: args.outputFilePrefix,
          outputGcsBucket: outputBucket,
          outputGcsPrefix: args.outputGcsPrefix,
          outputDir: args.outputDir,
          requireGcsUpload: true,
        });

      content.push({
        type: "text",
        text: `Uploaded ${uploadedOutputUris.length} transparent image(s) to:\n${uploadedOutputUris.join(
          "\n"
        )}`,
      });
      content.push({
        type: "text",
        text: `HTTP URL(s) (requires bucket access):\n${uploadedOutputUrls.join(
          "\n"
        )}`,
      });
      content.push({
        type: "text",
        text: `Saved ${savedPaths.length} image(s) to:\n${savedPaths.join("\n")}`,
      });

      Object.assign(
        structuredContent,
        buildOutputStructuredContent({
          outputImageUris: uploadedOutputUris,
          outputImageUrls: uploadedOutputUrls,
          savedPaths,
        })
      );
    }

    if (images.length === 0 && texts.length > 0) {
      content.push({
        type: "text",
        text: texts.join("\n"),
      });
    }

    return Object.keys(structuredContent).length
      ? { content, structuredContent }
      : { content };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Nano Banana error: ${message}` }],
      isError: true,
    };
  }
}

async function handleMakeTransparent(
  args: MakeTransparentArgs,
  progress?: ProgressReporter | null
): Promise<CallToolResult> {
  const method: TransparentMethod = args.method ?? "imgly";
  const heartbeatMessage =
    method === "gemini"
      ? "Generating transparent image..."
      : "Removing background...";
  const stopHeartbeat = progress?.startHeartbeat(heartbeatMessage);
  try {
    const content: Array<{ type: "text"; text: string }> = [];
    const structuredContent: Record<string, unknown> = {};

    if (method === "gemini") {
      progress?.report("Requesting transparency via Gemini.");
      const geminiArgs = await buildGeminiArgsForTransparency(args);
      const result = await generateImage(geminiArgs);
      const { images, texts } = extractImagesAndTexts(result.response);

      content.push({
        type: "text",
        text: `Generated ${images.length} transparent image(s) with model ${
          geminiArgs.model ?? DEFAULT_MODEL
        }.`,
      });

      if (args.includeText && texts.length > 0) {
        content.push({ type: "text", text: texts.join("\n") });
      }

      if (images.length > 0) {
        const outputImages = images.map((image) => ({
          mimeType: image.mimeType,
          data: Buffer.from(normalizeBase64(image.data), "base64"),
        }));
        const outputBucket = resolveOutputGcsBucket(args);
        const { uploadedOutputUris, uploadedOutputUrls, savedPaths } =
          await persistOutputImages({
            images: outputImages,
            outputFilePrefix: args.outputFilePrefix,
            outputGcsBucket: outputBucket,
            outputGcsPrefix: args.outputGcsPrefix,
            outputDir: args.outputDir,
            requireGcsUpload: false,
            skipGcsUpload: args.skipGcsUpload,
          });

        if (uploadedOutputUris.length > 0) {
          content.push({
            type: "text",
            text: `Uploaded ${uploadedOutputUris.length} image(s) to:\n${uploadedOutputUris.join(
              "\n"
            )}`,
          });
          content.push({
            type: "text",
            text: `HTTP URL(s) (requires bucket access):\n${uploadedOutputUrls.join(
              "\n"
            )}`,
          });
        }
        content.push({
          type: "text",
          text: `Saved ${savedPaths.length} image(s) to:\n${savedPaths.join("\n")}`,
        });

        const inlineData = args.returnInlineData
          ? images.map((image) => {
              const base64 = normalizeBase64(image.data);
              return `data:${image.mimeType};base64,${base64}`;
            })
          : [];

        if (args.returnInlineData) {
          content.push({
            type: "text",
            text: `Inline data:\n${inlineData.join("\n")}`,
          });
        }

        Object.assign(
          structuredContent,
          buildOutputStructuredContent({
            outputImageUris: uploadedOutputUris,
            outputImageUrls: uploadedOutputUrls,
            savedPaths,
            inlineData,
          })
        );
      }

      if (images.length === 0 && texts.length > 0) {
        content.push({
          type: "text",
          text: texts.join("\n"),
        });
      }

      return Object.keys(structuredContent).length
        ? { content, structuredContent }
        : { content };
    }

    if (method === "imgly") {
      progress?.report("Running IMG.LY background removal.");
      const { buffer, mimeType } = await resolveSourceImageBuffer(
        args.sourceImage
      );
      const outputFormatCandidate =
        args.imglyOutputFormat ?? DEFAULT_IMGLY_OUTPUT_FORMAT;
      const outputFormat =
        outputFormatCandidate === "image/png" ||
        outputFormatCandidate === "image/jpeg" ||
        outputFormatCandidate === "image/webp"
          ? outputFormatCandidate
          : "image/png";
      const modelCandidate = args.imglyModel ?? DEFAULT_IMGLY_MODEL;
      const model =
        modelCandidate === "small" ||
        modelCandidate === "medium" ||
        modelCandidate === "large"
          ? modelCandidate
          : "medium";
      const publicPath =
        args.imglyPublicPath?.trim() || DEFAULT_IMGLY_PUBLIC_PATH;
      const quality =
        typeof args.imglyOutputQuality === "number"
          ? args.imglyOutputQuality
          : Number.isFinite(DEFAULT_IMGLY_OUTPUT_QUALITY)
            ? DEFAULT_IMGLY_OUTPUT_QUALITY
            : undefined;
      const debug =
        typeof args.imglyDebug === "boolean" ? args.imglyDebug : undefined;

      const config: ImglyConfig = {
        model,
        output: {
          format: outputFormat,
          ...(typeof quality === "number" ? { quality } : {}),
        },
        ...(publicPath ? { publicPath } : {}),
        ...(typeof debug === "boolean" ? { debug } : {}),
      };

      const inputBlob = new Blob([new Uint8Array(buffer)], {
        type: mimeType,
      });
      const blob = await removeBackground(inputBlob, config);
      const outputBuffer = Buffer.from(await blob.arrayBuffer());

      const outputImages = [
        {
          mimeType: outputFormat,
          data: outputBuffer,
        },
      ];
      const outputBucket = resolveOutputGcsBucket(args);
      const { uploadedOutputUris, uploadedOutputUrls, savedPaths } =
        await persistOutputImages({
          images: outputImages,
          outputFilePrefix: args.outputFilePrefix,
          outputGcsBucket: outputBucket,
          outputGcsPrefix: args.outputGcsPrefix,
          outputDir: args.outputDir,
          requireGcsUpload: false,
          skipGcsUpload: args.skipGcsUpload,
        });

      content.push({
        type: "text",
        text: `Generated 1 transparent image using IMG.LY (${model}).`,
      });

      if (uploadedOutputUris.length > 0) {
        content.push({
          type: "text",
          text: `Uploaded 1 image to:\n${uploadedOutputUris.join("\n")}`,
        });
        content.push({
          type: "text",
          text: `HTTP URL(s) (requires bucket access):\n${uploadedOutputUrls.join(
            "\n"
          )}`,
        });
      }
      content.push({
        type: "text",
        text: `Saved 1 image to:\n${savedPaths.join("\n")}`,
      });

      if (args.returnInlineData) {
        const base64 = outputBuffer.toString("base64");
        content.push({
          type: "text",
          text: `Inline data:\ndata:${outputFormat};base64,${base64}`,
        });
      }

      Object.assign(
        structuredContent,
        buildOutputStructuredContent({
          outputImageUris: uploadedOutputUris,
          outputImageUrls: uploadedOutputUrls,
          savedPaths,
          ...(args.returnInlineData
            ? {
                inlineData: [
                  `data:${outputFormat};base64,${outputBuffer.toString(
                    "base64"
                  )}`,
                ],
              }
            : {}),
        })
      );

      return Object.keys(structuredContent).length
        ? { content, structuredContent }
        : { content };
    }

    if (method === "color-key") {
      progress?.report("Applying color-key transparency.");
      const { buffer } = await resolveSourceImageBuffer(args.sourceImage);
      const color = args.color ? parseHexColor(args.color) : undefined;
      const outputBuffer = await applyColorKeyTransparency({
        buffer,
        color,
        tolerance: args.tolerance,
        feather: args.feather,
      });
      const outputImages = [
        {
          mimeType: "image/png",
          data: outputBuffer,
        },
      ];
      const outputBucket = resolveOutputGcsBucket(args);
      const { uploadedOutputUris, uploadedOutputUrls, savedPaths } =
        await persistOutputImages({
          images: outputImages,
          outputFilePrefix: args.outputFilePrefix,
          outputGcsBucket: outputBucket,
          outputGcsPrefix: args.outputGcsPrefix,
          outputDir: args.outputDir,
          requireGcsUpload: false,
          skipGcsUpload: args.skipGcsUpload,
        });

      content.push({
        type: "text",
        text: "Generated 1 transparent image using color-key.",
      });

      if (uploadedOutputUris.length > 0) {
        content.push({
          type: "text",
          text: `Uploaded 1 image to:\n${uploadedOutputUris.join("\n")}`,
        });
        content.push({
          type: "text",
          text: `HTTP URL(s) (requires bucket access):\n${uploadedOutputUrls.join(
            "\n"
          )}`,
        });
      }
      content.push({
        type: "text",
        text: `Saved 1 image to:\n${savedPaths.join("\n")}`,
      });

      if (args.returnInlineData) {
        const base64 = outputBuffer.toString("base64");
        content.push({
          type: "text",
          text: `Inline data:\ndata:image/png;base64,${base64}`,
        });
      }

      Object.assign(
        structuredContent,
        buildOutputStructuredContent({
          outputImageUris: uploadedOutputUris,
          outputImageUrls: uploadedOutputUrls,
          savedPaths,
          ...(args.returnInlineData
            ? {
                inlineData: [
                  `data:image/png;base64,${outputBuffer.toString("base64")}`,
                ],
              }
            : {}),
        })
      );

      return Object.keys(structuredContent).length
        ? { content, structuredContent }
        : { content };
    }

    if (method === "checkerboard") {
      progress?.report("Detecting checkerboard background.");
      const { buffer } = await resolveSourceImageBuffer(args.sourceImage);
      const { outputBuffer, colors, coverage } =
        await applyCheckerboardTransparency({
          buffer,
          tolerance: args.tolerance,
          feather: args.feather,
        });
      const outputImages = [
        {
          mimeType: "image/png",
          data: outputBuffer,
        },
      ];
      const outputBucket = resolveOutputGcsBucket(args);
      const { uploadedOutputUris, uploadedOutputUrls, savedPaths } =
        await persistOutputImages({
          images: outputImages,
          outputFilePrefix: args.outputFilePrefix,
          outputGcsBucket: outputBucket,
          outputGcsPrefix: args.outputGcsPrefix,
          outputDir: args.outputDir,
          requireGcsUpload: false,
          skipGcsUpload: args.skipGcsUpload,
        });

      const detectedColors = colors
        .map((color) => formatHexColor(color))
        .join(", ");
      content.push({
        type: "text",
        text: `Detected background colors: ${detectedColors}.`,
      });
      if (coverage < 0.6) {
        content.push({
          type: "text",
          text: `Background coverage is ${(coverage * 100).toFixed(
            1
          )}%, results may be imperfect.`,
        });
      }
      content.push({
        type: "text",
        text: "Generated 1 transparent image using checkerboard detection.",
      });

      if (uploadedOutputUris.length > 0) {
        content.push({
          type: "text",
          text: `Uploaded 1 image to:\n${uploadedOutputUris.join("\n")}`,
        });
        content.push({
          type: "text",
          text: `HTTP URL(s) (requires bucket access):\n${uploadedOutputUrls.join(
            "\n"
          )}`,
        });
      }
      content.push({
        type: "text",
        text: `Saved 1 image to:\n${savedPaths.join("\n")}`,
      });

      if (args.returnInlineData) {
        const base64 = outputBuffer.toString("base64");
        content.push({
          type: "text",
          text: `Inline data:\ndata:image/png;base64,${base64}`,
        });
      }

      Object.assign(
        structuredContent,
        buildOutputStructuredContent({
          outputImageUris: uploadedOutputUris,
          outputImageUrls: uploadedOutputUrls,
          savedPaths,
          ...(args.returnInlineData
            ? {
                inlineData: [
                  `data:image/png;base64,${outputBuffer.toString("base64")}`,
                ],
              }
            : {}),
        })
      );

      return Object.keys(structuredContent).length
        ? { content, structuredContent }
        : { content };
    }

    throw new Error(`Unsupported method "${method}".`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Nano Banana error: ${message}` }],
      isError: true,
    };
  } finally {
    stopHeartbeat?.();
  }
}

async function handleGetPollingTask(
  args: PollingTaskArgs
): Promise<CallToolResult> {
  const taskId = args.taskId?.trim();
  if (!taskId) {
    return buildErrorResult("taskId is required.");
  }

  const task = pollingTasks.get(taskId);
  if (!task) {
    return buildErrorResult(`Task ${taskId} not found.`);
  }

  const structuredContent: Record<string, unknown> = {
    taskId,
    taskStatus: task.status,
  };
  if (task.expiresAt) {
    structuredContent.taskExpiresAt = new Date(task.expiresAt).toISOString();
  }

  if (task.status === "completed" || task.status === "failed") {
    const result =
      task.result ??
      buildErrorResult(`Task ${taskId} ${task.status} with no result.`);
    return {
      ...result,
      structuredContent: {
        ...(result.structuredContent ?? {}),
        ...structuredContent,
      },
    };
  }

  return {
    content: [
      {
        type: "text",
        text: `Task ${taskId} status: ${task.status}.`,
      },
    ],
    structuredContent,
  };
}

const taskStore = new InMemoryTaskStore();
const taskMessageQueue = new InMemoryTaskMessageQueue();

const server = new Server(
  {
    name: "nano-banana-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
      tasks: {
        list: {},
        cancel: {},
        requests: {
          tools: {
            call: {},
          },
        },
      },
    },
    taskStore,
    taskMessageQueue,
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "nano_banana_generate_image",
      description:
        "Generate images with Gemini 3 Pro Image on Vertex AI and upload results to GCS. If the prompt mentions transparency, the server will render on a key color and return a true transparent PNG automatically. Prefer referenceImagePaths or referenceImageUris to avoid base64. For 4K imageSize requests, the server may return a polling task (or MCP task when explicitly requested) when auto-task mode is enabled to avoid client timeouts.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "Text prompt for image generation.",
          },
          transparencyKeyColor: {
            type: "string",
            description:
              "Hex key color for auto-transparency (used when prompt requests transparency).",
            default: DEFAULT_TRANSPARENCY_KEY_COLOR,
          },
          opaqueBackgroundColor: {
            type: "string",
            description:
              "Hex color (or 'auto') to flatten outputs and remove alpha when transparency is not requested. Use 'off' to keep alpha.",
            ...(DEFAULT_OPAQUE_BACKGROUND_COLOR
              ? { default: DEFAULT_OPAQUE_BACKGROUND_COLOR }
              : {}),
          },
          referenceImages: {
            type: "array",
            description:
              "Legacy base64-encoded images (prefer referenceImagePaths or referenceImageUris).",
            items: {
              type: "object",
              properties: {
                mimeType: {
                  type: "string",
                  description: "MIME type like image/png or image/jpeg.",
                },
                data: {
                  type: "string",
                  description: "Base64 image data or data URI.",
                },
              },
              required: ["mimeType", "data"],
            },
          },
          referenceImageUris: {
            type: "array",
            description:
              "Optional GCS image URIs for editing or multi-image prompts.",
            items: {
              type: "object",
              properties: {
                mimeType: {
                  type: "string",
                  description: "MIME type like image/png or image/jpeg.",
                },
                fileUri: {
                  type: "string",
                  description: "GCS URI like gs://bucket/path.png.",
                },
                displayName: {
                  type: "string",
                  description: "Optional label for the image.",
                },
              },
              required: ["mimeType", "fileUri"],
            },
          },
          referenceImagePaths: {
            type: "array",
            description:
              "Optional local image paths to upload to GCS and use as references.",
            items: {
              type: "object",
              properties: {
                path: {
                  type: "string",
                  description: "Absolute or relative path to a local image.",
                },
                mimeType: {
                  type: "string",
                  description:
                    "Optional MIME type; inferred from the file extension if omitted.",
                },
                displayName: {
                  type: "string",
                  description: "Optional label for the image.",
                },
                objectName: {
                  type: "string",
                  description:
                    "Optional GCS object name (defaults to a timestamped name).",
                },
              },
              required: ["path"],
            },
          },
          aspectRatio: {
            type: "string",
            description:
              "Aspect ratio like 1:1, 16:9, 4:3. Gemini 2.5 Flash Image supports fixed ratios.",
          },
          imageSize: {
            type: "string",
            description:
              "Image size (1K, 2K, 4K) for models that support it (e.g. Gemini 3 Pro Image Preview).",
          },
          includeText: {
            type: "boolean",
            description: "Include text parts in the MCP response.",
            default: false,
          },
          responseModalities: {
            type: "array",
            description: "Override response modalities.",
            items: {
              type: "string",
              enum: ["TEXT", "IMAGE"],
            },
          },
          candidateCount: {
            type: "integer",
            description: "Number of candidates to request (1-8).",
            minimum: 1,
            maximum: 8,
          },
          model: {
            type: "string",
            description:
              "Override the model ID (default: gemini-3-pro-image-preview).",
          },
          location: {
            type: "string",
            description:
              "Vertex region (default: VERTEX_LOCATION or global).",
          },
          projectId: {
            type: "string",
            description:
              "Override the GCP project ID (default from env or service account).",
          },
          gcsBucket: {
            type: "string",
            description: `GCS bucket for reference image uploads${
              DEFAULT_GCS_BUCKET ? ` (default: ${DEFAULT_GCS_BUCKET})` : ""
            }.`,
            ...(DEFAULT_GCS_BUCKET ? { default: DEFAULT_GCS_BUCKET } : {}),
          },
          gcsUploadPrefix: {
            type: "string",
            description:
              "GCS object prefix for uploaded reference images.",
            default: DEFAULT_GCS_UPLOAD_PREFIX,
          },
          outputGcsBucket: {
            type: "string",
            description: `GCS bucket for generated image uploads${
              DEFAULT_OUTPUT_GCS_BUCKET
                ? ` (default: ${DEFAULT_OUTPUT_GCS_BUCKET})`
                : ""
            }.`,
            ...(DEFAULT_OUTPUT_GCS_BUCKET
              ? { default: DEFAULT_OUTPUT_GCS_BUCKET }
              : {}),
          },
          outputGcsPrefix: {
            type: "string",
            description: "GCS object prefix for generated image uploads.",
            default: DEFAULT_OUTPUT_GCS_PREFIX,
          },
          outputDir: {
            type: "string",
            description:
              "Directory to save generated images on disk (relative paths resolve under NANO_BANANA_OUTPUT_DIR).",
            default: DEFAULT_OUTPUT_DIR,
          },
          outputFilePrefix: {
            type: "string",
            description:
              "Optional filename prefix used for GCS object names and local files.",
          },
        },
      },
    },
    {
      name: "nano_banana_get_task",
      description:
        "Get status/results for polling tasks returned by nano_banana_generate_image when auto-task is enabled. Wait a few seconds between polls to avoid hammering the server.",
      inputSchema: {
        type: "object",
        required: ["taskId"],
        properties: {
          taskId: {
            type: "string",
            description: "Task ID returned by nano_banana_generate_image.",
          },
        },
      },
    },
    {
      name: "nano_banana_make_transparent",
      description:
        "Make a source image transparent (Gemini background removal or color-key) and save/upload the result.",
      inputSchema: {
        type: "object",
        required: ["sourceImage"],
        properties: {
          sourceImage: {
            type: "object",
            description:
              "Source image input. Provide data (base64), fileUri (gs://), or path.",
            properties: {
              mimeType: {
                type: "string",
                description:
                  "MIME type like image/png or image/jpeg (required for data or fileUri).",
              },
              data: {
                type: "string",
                description: "Base64 image data or data URI.",
              },
              fileUri: {
                type: "string",
                description: "GCS URI like gs://bucket/path.png.",
              },
              path: {
                type: "string",
                description: "Absolute or relative path to a local image.",
              },
              displayName: {
                type: "string",
                description: "Optional label for the image.",
              },
            },
            anyOf: [
              { required: ["data"] },
              { required: ["fileUri"] },
              { required: ["path"] },
            ],
          },
          method: {
            type: "string",
            enum: ["imgly", "gemini", "color-key", "checkerboard"],
            description:
              "imgly uses @imgly/background-removal-node; gemini uses Vertex; color-key removes a flat color locally; checkerboard detects two background colors from the border.",
            default: "imgly",
          },
          prompt: {
            type: "string",
            description:
              "Optional prompt override for gemini (default: remove background, transparent PNG).",
          },
          color: {
            type: "string",
            description:
              "Hex color for color-key (e.g. #ffffff). Defaults to top-left pixel.",
          },
          tolerance: {
            type: "number",
            description: "Color distance tolerance (0-255).",
            minimum: 0,
            maximum: 255,
          },
          feather: {
            type: "number",
            description: "Soft edge feathering (0-255).",
            minimum: 0,
            maximum: 255,
          },
          returnInlineData: {
            type: "boolean",
            description: "Return base64 data in the MCP response.",
            default: false,
          },
          skipGcsUpload: {
            type: "boolean",
            description:
              "Skip uploading to GCS (still saves locally).",
            default: false,
          },
          includeText: {
            type: "boolean",
            description: "Include text parts in the MCP response.",
            default: false,
          },
          responseModalities: {
            type: "array",
            description: "Override response modalities.",
            items: {
              type: "string",
              enum: ["TEXT", "IMAGE"],
            },
          },
          candidateCount: {
            type: "integer",
            description: "Number of candidates to request (1-8).",
            minimum: 1,
            maximum: 8,
          },
          model: {
            type: "string",
            description:
              "Override the model ID (default: gemini-3-pro-image-preview).",
          },
          location: {
            type: "string",
            description:
              "Vertex region (default: VERTEX_LOCATION or global).",
          },
          projectId: {
            type: "string",
            description:
              "Override the GCP project ID (default from env or service account).",
          },
          outputGcsBucket: {
            type: "string",
            description: `GCS bucket for output uploads${
              DEFAULT_OUTPUT_GCS_BUCKET
                ? ` (default: ${DEFAULT_OUTPUT_GCS_BUCKET})`
                : ""
            }.`,
            ...(DEFAULT_OUTPUT_GCS_BUCKET
              ? { default: DEFAULT_OUTPUT_GCS_BUCKET }
              : {}),
          },
          outputGcsPrefix: {
            type: "string",
            description: "GCS object prefix for output uploads.",
            default: DEFAULT_OUTPUT_GCS_PREFIX,
          },
          outputDir: {
            type: "string",
            description:
              "Directory to save outputs on disk (relative paths resolve under NANO_BANANA_OUTPUT_DIR).",
            default: DEFAULT_OUTPUT_DIR,
          },
          outputFilePrefix: {
            type: "string",
            description:
              "Optional filename prefix used when saving images and naming GCS objects.",
          },
          imglyModel: {
            type: "string",
            enum: ["small", "medium", "large"],
            description:
              "IMG.LY model size (small is faster, medium is higher quality).",
            default: DEFAULT_IMGLY_MODEL,
          },
          imglyOutputFormat: {
            type: "string",
            enum: ["image/png", "image/jpeg", "image/webp"],
            description: "Output format for IMG.LY background removal.",
            default: DEFAULT_IMGLY_OUTPUT_FORMAT,
          },
          imglyOutputQuality: {
            type: "number",
            description: "Output quality for JPEG/WebP (0-1).",
            minimum: 0,
            maximum: 1,
          },
          imglyPublicPath: {
            type: "string",
            description:
              "Custom public path for IMG.LY wasm/onnx assets (file:// or https://).",
            default: DEFAULT_IMGLY_PUBLIC_PATH,
          },
          imglyDebug: {
            type: "boolean",
            description: "Enable IMG.LY debug logging.",
            default: false,
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const progress = createProgressReporter(extra);
  const taskParams = request.params.task;
  const autoTask =
    !taskParams &&
    shouldAutoTaskFor4k(
      request.params.name,
      request.params.arguments as ToolArgs
    );

  const runTool = async (
    progressOverride: ProgressReporter | null = progress
  ): Promise<CallToolResult> => {
    switch (request.params.name) {
      case "nano_banana_generate_image":
        return handleGenerateImage(
          request.params.arguments as ToolArgs,
          progressOverride
        );
      case "nano_banana_get_task":
        return handleGetPollingTask(
          request.params.arguments as PollingTaskArgs
        );
      case "nano_banana_make_transparent":
        return handleMakeTransparent(
          request.params.arguments as MakeTransparentArgs,
          progressOverride
        );
      default:
        throw new Error(`Unknown tool: ${request.params.name}`);
    }
  };

  if (taskParams) {
    if (!extra.taskStore) {
      throw new Error(
        "Task requests are not supported because no task store is configured."
      );
    }

    const taskOptions = taskParams ?? {
      ttl: DEFAULT_AUTO_TASK_TTL_MS,
    };
    const task = await extra.taskStore.createTask(taskOptions);
    void (async () => {
      try {
        const result = await runTool();
        const status = result.isError ? "failed" : "completed";
        await extra.taskStore?.storeTaskResult(task.taskId, status, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await extra.taskStore?.storeTaskResult(task.taskId, "failed", {
          ...buildErrorResult(message),
        });
      }
    })();

    return { task };
  }

  if (autoTask) {
    const task = createPollingTask();
    void (async () => {
      try {
        setPollingTaskStatus(task.taskId, "working");
        const result = await runTool(null);
        storePollingTaskResult(task.taskId, result);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        storePollingTaskResult(task.taskId, buildErrorResult(message));
      }
    })();

    return {
      content: [
        {
          type: "text",
          text: `Task ${task.taskId} queued. Poll with nano_banana_get_task.`,
        },
      ],
      structuredContent: {
        taskId: task.taskId,
        taskStatus: task.status,
      },
    };
  }

  return runTool();
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Failed to start nano-banana-mcp:", error);
  process.exit(1);
});
