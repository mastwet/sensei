// videoin — port of senpi builtin `video-in/` (kimi-code ReadMediaFile parity).
// `read_video` reads a local video into the conversation as a base64 video payload.
// Active only when the model declares "video" in its input modalities; the payload
// rides an ImageContent block with a video/* mimeType (the provider layer decides
// how to serialize or downgrade it).

import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve as resolvePath } from "node:path";

const TOOL_NAME = "read_video";
const MAX_VIDEO_MEGABYTES = 100;
const MAX_VIDEO_BYTES = MAX_VIDEO_MEGABYTES * 1024 * 1024;

const EXT_TO_MIME: Record<string, string> = {
  mp4: "video/mp4",
  mpeg: "video/mpeg",
  mpg: "video/mpeg",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  flv: "video/x-flv",
  "3gp": "video/3gpp",
};

function detectVideoMimeType(path: string): string | undefined {
  return EXT_TO_MIME[extname(path).slice(1).toLowerCase()];
}

function modelSupportsVideo(model: any): boolean {
  return model?.input?.includes("video") === true;
}

export default function (pi: any): void {
  pi.registerTool({
    name: TOOL_NAME,
    label: "Read Video",
    description:
      `Read a video file (${Object.keys(EXT_TO_MIME).join(", ")}) and attach it to the conversation so you can watch it. ` +
      `Maximum file size ${MAX_VIDEO_MEGABYTES}MB. ` +
      "Use this to understand screen recordings, demo clips, or any behavior that is hard to describe in text. " +
      "If you generate or edit a video via commands or scripts, read the result back before continuing.",
    promptSnippet: "Attach a video file so the model can watch it (video-capable models only)",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to a video file (relative or absolute). Max 100MB." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(_id: string, params: any, signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      if (signal?.aborted) throw new Error("Operation aborted");
      if (!modelSupportsVideo(ctx.model)) {
        throw new Error(
          "The current model does not support video input. Tell the user to switch to a model with video input capability.",
        );
      }
      const absolutePath = isAbsolute(params.path) ? params.path : resolvePath(ctx.cwd, params.path);
      const mimeType = detectVideoMimeType(absolutePath);
      if (!mimeType) {
        throw new Error(`"${params.path}" is not a supported video file. Supported extensions: ${Object.keys(EXT_TO_MIME).join(", ")}.`);
      }
      const stats = await fsStat(absolutePath);
      if (!stats.isFile()) throw new Error(`"${params.path}" is not a regular file.`);
      if (stats.size === 0) throw new Error(`"${params.path}" is empty.`);
      if (stats.size > MAX_VIDEO_BYTES) {
        throw new Error(
          `"${params.path}" is ${stats.size} bytes, which exceeds the maximum ${MAX_VIDEO_MEGABYTES}MB for video files. Create a smaller clip (e.g. with ffmpeg) and read that instead.`,
        );
      }
      const data = await fsReadFile(absolutePath);
      if (signal?.aborted) throw new Error("Operation aborted");
      return {
        content: [
          { type: "text", text: `Read video file "${basename(absolutePath)}" [${mimeType}, ${stats.size} bytes]. The video is attached below.` },
          { type: "image", data: data.toString("base64"), mimeType },
        ],
        details: undefined,
      };
    },
  });

  function syncToolActivation(model: any): void {
    const active = pi.getActiveTools();
    const isActive = active.includes(TOOL_NAME);
    const shouldBeActive = modelSupportsVideo(model);
    if (shouldBeActive && !isActive) pi.setActiveTools([...active, TOOL_NAME]);
    else if (!shouldBeActive && isActive) pi.setActiveTools(active.filter((n: string) => n !== TOOL_NAME));
  }

  pi.on("session_start", async (_e: any, ctx: any) => syncToolActivation(ctx.model));
  pi.on("model_select", async (event: any) => syncToolActivation(event.model));
}
