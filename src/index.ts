import "dotenv/config";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { GoogleAuth } from "google-auth-library";

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

function resolveOutputGcsBucket(args: ToolArgs): string | null {
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

const server = new Server(
  {
    name: "nano-banana-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "nano_banana_generate_image",
      description:
        "Generate images with Gemini 3 Pro Image on Vertex AI and upload results to GCS. Prefer referenceImagePaths or referenceImageUris to avoid base64.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "Text prompt for image generation.",
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
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "nano_banana_generate_image") {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const args = request.params.arguments as ToolArgs;

  try {
    const result = await generateImage(args);
    const images: Array<{ mimeType: string; data: string }> = [];
    const texts: string[] = [];

    for (const candidate of result.response.candidates ?? []) {
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

    const content: Array<{ type: "text"; text: string }> = [];

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
      const outputTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const outputPrefix = args.outputFilePrefix?.trim() || "nano-banana";
      const outputBucket = resolveOutputGcsBucket(args);
      if (!outputBucket) {
        throw new Error(
          "Output GCS bucket not set. Provide outputGcsBucket or set NANO_BANANA_OUTPUT_GCS_BUCKET (or NANO_BANANA_GCS_BUCKET)."
        );
      }
      const outputGcsPrefix = normalizeGcsPrefix(
        args.outputGcsPrefix,
        DEFAULT_OUTPUT_GCS_PREFIX
      );
      const uploadedOutputUris: string[] = [];
      const uploadedOutputUrls: string[] = [];

      for (let i = 0; i < images.length; i += 1) {
        const image = images[i];
        const ext = extensionForMimeType(image.mimeType);
        const filename = `${outputPrefix}-${outputTimestamp}-${i + 1}.${ext}`;
        const objectName = `${outputGcsPrefix}/${filename}`;
        await uploadBufferToGcs({
          bucket: outputBucket,
          objectName,
          mimeType: image.mimeType,
          data: Buffer.from(normalizeBase64(image.data), "base64"),
        });
        uploadedOutputUris.push(`gs://${outputBucket}/${objectName}`);
        uploadedOutputUrls.push(
          `https://storage.googleapis.com/${outputBucket}/${objectName}`
        );
      }

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

      const resolvedOutputDir = resolveOutputDir(args.outputDir);
      await mkdir(resolvedOutputDir, { recursive: true });
      const savedPaths: string[] = [];

      for (let i = 0; i < images.length; i += 1) {
        const image = images[i];
        const ext = extensionForMimeType(image.mimeType);
        const filename = `${outputPrefix}-${outputTimestamp}-${i + 1}.${ext}`;
        const outputPath = path.join(resolvedOutputDir, filename);
        await writeFile(
          outputPath,
          Buffer.from(normalizeBase64(image.data), "base64")
        );
        savedPaths.push(outputPath);
      }

      content.push({
        type: "text",
        text: `Saved ${savedPaths.length} image(s) to:\n${savedPaths.join("\n")}`,
      });
    }

    if (images.length === 0 && texts.length > 0) {
      content.push({
        type: "text",
        text: texts.join("\n"),
      });
    }

    return { content };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Nano Banana error: ${message}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Failed to start nano-banana-mcp:", error);
  process.exit(1);
});
