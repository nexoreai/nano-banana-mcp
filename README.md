# nano-banana-mcp

![Architecture Diagram](./architecture.png)

MCP server that generates images with Gemini 3 Pro Image on Vertex AI.

## Requirements

- Node.js 18+
- Vertex AI API enabled in your GCP project
- A service account with permission to call Vertex AI

## Setup

```bash
npm install
```

Create a `.env` file or export the variables directly:

```bash
export GOOGLE_SERVICE_ACCOUNT_JSON='{"type":"service_account","project_id":"your-project","private_key":"...","client_email":"..."}'
# or point to a JSON file
export GOOGLE_SERVICE_ACCOUNT_JSON=/absolute/path/to/service-account.json

export VERTEX_PROJECT_ID=your-project
export VERTEX_LOCATION=global
export NANO_BANANA_MODEL=gemini-3-pro-image-preview
```

Notes:
- `GOOGLE_SERVICE_ACCOUNT_JSON` is required (JSON string or file path).
- `VERTEX_PROJECT_ID` is optional if the service account JSON includes `project_id`.
- The default model is `gemini-3-pro-image-preview` (Vertex preview). Override with another model ID if needed.
- If you see a 404 error with `global`, try a supported region like `us-central1` or `europe-west4`.

## Run

```bash
npm run dev
```

## MCP tool

Tool name: `nano_banana_generate_image`

Example arguments:

```json
{
  "prompt": "A cozy ramen shop on a rainy night, cinematic lighting",
  "aspectRatio": "16:9",
  "includeText": false
}
```

Optional fields:
- `referenceImages`: array of `{ "mimeType": "image/png", "data": "<base64>" }`
- `responseModalities`: `["IMAGE"]` or `["TEXT", "IMAGE"]`
- `candidateCount`: integer 1-8
- `imageSize`: `1K`, `2K`, `4K` (for models that support it)
- `model`, `location`, `projectId`: overrides
- `outputDir`: directory to save generated images on disk (absolute or relative)
- `outputFilePrefix`: filename prefix used when saving images

## References

- Gemini 3 Pro Image model card: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-pro-image
- Gemini image generation docs (model IDs, response format): https://ai.google.dev/gemini-api/docs/image-generation
