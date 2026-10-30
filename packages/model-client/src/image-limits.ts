import type { EndpointSnapshot, ModelSnapshot } from "./catalog.js";
import { MAX_MODEL_IMAGES } from "./contracts.js";

/**
 * Documented request limits of the provider that serves an endpoint. Basalt refuses a request
 * that exceeds a limit of an endpoint in the set before it reserves spending. Basalt never
 * resizes an image.
 */
interface ImageRequestLimits {
  source: string;
  maxImages: number;
  /** Encoded request body, in bytes. */
  maxRequestBytes: number | null;
  /** Base64 text of one image, in characters. */
  maxEncodedImageBytes: number | null;
  /** Longest image edge, in pixels. */
  maxImageEdge: number | null;
  /** A stricter edge limit for each image when a request has more than `above` images. */
  manyImages: { above: number; maxImageEdge: number } | null;
}

const MB = 1_000_000;
const MIB = 1024 * 1024;
const BASALT: ImageRequestLimits = {
  source: "Basalt image bounds",
  maxImages: MAX_MODEL_IMAGES,
  maxRequestBytes: null,
  maxEncodedImageBytes: null,
  maxImageEdge: null,
  manyImages: null,
};

function stricter(limits: Omit<ImageRequestLimits, "maxImages"> & { maxImages: number }) {
  return { ...limits, maxImages: Math.min(limits.maxImages, MAX_MODEL_IMAGES) };
}

export function imageRequestLimits(id: string, endpoint: EndpointSnapshot): ImageRequestLimits {
  const provider = endpoint.provider;
  if (id.startsWith("anthropic/")) {
    // The direct API and the Anthropic-operated platforms accept 32 MB requests. Partner
    // platforms are lower: Amazon Bedrock 20 MB and Google Cloud 30 MB. An unknown host
    // receives the lowest documented limits.
    const direct = provider === "Anthropic";
    const vertex = provider === "Google" || provider === "Google Vertex";
    return stricter({
      source:
        "https://platform.claude.com/docs/en/build-with-claude/vision and https://platform.claude.com/docs/en/api/overview",
      maxImages: endpoint.contextLength <= 200_000 ? 100 : 600,
      maxRequestBytes: direct ? 32 * MB : vertex ? 30 * MB : 20 * MB,
      maxEncodedImageBytes: direct ? 10 * MB : 5 * MB,
      maxImageEdge: 8000,
      manyImages: { above: 20, maxImageEdge: 2000 },
    });
  }
  if (id.startsWith("openai/") && provider === "OpenAI")
    return stricter({
      source: "https://developers.openai.com/api/docs/guides/images-vision",
      maxImages: 1500,
      maxRequestBytes: 512 * MB,
      maxEncodedImageBytes: null,
      maxImageEdge: null,
      manyImages: null,
    });
  if (id.startsWith("google/gemini-"))
    return stricter({
      source: "https://ai.google.dev/gemini-api/docs/image-understanding",
      maxImages: 3600,
      maxRequestBytes: 20 * MB,
      maxEncodedImageBytes: null,
      maxImageEdge: null,
      manyImages: null,
    });
  if (id.startsWith("deepseek/") && provider === "DeepSeek")
    return stricter({
      source: "https://api-docs.deepseek.com/guides/vision/",
      maxImages: 600,
      maxRequestBytes: 48 * MIB,
      maxEncodedImageBytes: 32 * MIB,
      maxImageEdge: 8192,
      manyImages: { above: 14, maxImageEdge: 4096 },
    });
  if (id === "xiaomi/mimo-v2.6-flash") {
    // OpenRouter does not publish these counts. Three hosts rejected a request with 30 images
    // on 2026-10-02, and their errors gave the counts. Xiaomi, Novita and InferenceNet accepted it.
    const maxImages = ({ DeepInfra: 4, "Io Net": 9, Venice: 10 } as Record<string, number>)[
      provider
    ];
    if (maxImages !== undefined)
      return stricter({
        source: "Provider rejections of a request with 30 images on 2026-10-02",
        maxImages,
        maxRequestBytes: null,
        maxEncodedImageBytes: null,
        maxImageEdge: null,
        manyImages: null,
      });
  }
  if (id.startsWith("meta/") && provider === "Meta")
    return stricter({
      source: "https://dev.meta.ai/docs/image-understanding",
      maxImages: 50,
      maxRequestBytes: null,
      maxEncodedImageBytes: 50 * MB,
      maxImageEdge: null,
      manyImages: null,
    });
  return BASALT;
}

/**
 * Refuse a request that the frozen endpoint cannot accept. At quote time the encoded sizes and
 * some dimensions are unknown; dispatch admission checks them again with the actual images.
 */
export function assertImageRequestLimits(
  snapshot: ModelSnapshot,
  images: Array<{ width: number | null; height: number | null; encodedBytes: number | null }>,
  requestTextBytes: number | null,
): void {
  if (!images.length) return;
  // OpenRouter can send the request to any endpoint of the set, so each limit must hold.
  for (const endpoint of snapshot.endpoints)
    assertEndpointImageLimits(snapshot.id, endpoint, images, requestTextBytes);
}

function assertEndpointImageLimits(
  id: string,
  endpoint: EndpointSnapshot,
  images: Array<{ width: number | null; height: number | null; encodedBytes: number | null }>,
  requestTextBytes: number | null,
): void {
  const limits = imageRequestLimits(id, endpoint);
  const refuse = (detail: string) =>
    new Error(
      `${detail} Basalt does not resize images. Use fewer images, or select a different model. Source: ${limits.source}.`,
    );
  if (images.length > limits.maxImages)
    throw refuse(
      `The endpoint ${endpoint.tag} of ${id} accepts at most ${limits.maxImages} images in one request. This request has ${images.length} images.`,
    );
  const edge =
    limits.manyImages && images.length > limits.manyImages.above
      ? Math.min(limits.maxImageEdge ?? Infinity, limits.manyImages.maxImageEdge)
      : limits.maxImageEdge;
  images.forEach((image, index) => {
    if (edge !== null && image.width !== null && image.height !== null) {
      const longest = Math.max(image.width, image.height);
      if (longest > edge)
        throw refuse(
          `The endpoint ${endpoint.tag} of ${id} accepts an image edge of at most ${edge} px in this request. Image ${index + 1} has an edge of ${longest} px.`,
        );
    }
    if (
      limits.maxEncodedImageBytes !== null &&
      image.encodedBytes !== null &&
      image.encodedBytes > limits.maxEncodedImageBytes
    )
      throw refuse(
        `The endpoint ${endpoint.tag} of ${id} accepts at most ${limits.maxEncodedImageBytes} encoded bytes for one image. Image ${index + 1} has ${image.encodedBytes} encoded bytes.`,
      );
  });
  if (
    limits.maxRequestBytes !== null &&
    requestTextBytes !== null &&
    images.every((image) => image.encodedBytes !== null)
  ) {
    // Each image also carries its data URL prefix in the request body.
    const total = images.reduce((sum, image) => sum + image.encodedBytes! + 64, requestTextBytes);
    if (total > limits.maxRequestBytes)
      throw refuse(
        `The endpoint ${endpoint.tag} of ${id} accepts a request of at most ${limits.maxRequestBytes} bytes. This request has approximately ${total} bytes.`,
      );
  }
}
