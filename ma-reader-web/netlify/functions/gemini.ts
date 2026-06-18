import type { Handler } from "@netlify/functions";

const GEMINI_MODEL = "gemini-3.1-flash-lite";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

interface GeminiRequestBody {
  apiKey?: string;
  imageDataUrl?: string;
  imageDataUrls?: string[];
  prompt?: string;
  responseMimeType?: "application/json" | "text/plain";
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  let body: GeminiRequestBody;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const apiKey = body.apiKey?.trim();
  const prompt = body.prompt || "";
  const responseMimeType = body.responseMimeType || "application/json";
  const imageDataUrls = [body.imageDataUrl, ...(body.imageDataUrls ?? [])].filter(Boolean) as string[];

  if (!apiKey || !prompt) {
    return json(400, { error: "Missing apiKey or prompt" });
  }

  const images = imageDataUrls.map(parseDataUrl);
  if (images.some((image) => !image)) {
    return json(400, { error: "Invalid image data" });
  }

  try {
    const response = await fetch(GEMINI_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              ...images.map((image) => ({
                inline_data: {
                  mime_type: image!.mimeType,
                  data: image!.base64
                }
              }))
            ]
          }
        ],
        generationConfig: {
          temperature: 0.1,
          topP: 0.95,
          maxOutputTokens: 8192,
          responseMimeType
        }
      })
    });

    const payload = await response.json().catch(() => null) as GeminiResponse | null;
    if (!response.ok) {
      return json(response.status, { error: extractGeminiError(payload) });
    }

    const text = payload?.candidates?.[0]?.content?.parts
      ?.map((part: { text?: string }) => part.text || "")
      .join("")
      .trim();

    if (!text) {
      return json(502, { error: "Gemini returned an empty response" });
    }

    return json(200, { text });
  } catch {
    return json(502, { error: "Failed to contact Gemini" });
  }
};

function parseDataUrl(value: string): { mimeType: string; base64: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(value);
  if (!match) {
    return null;
  }

  return { mimeType: match[1], base64: match[2] };
}

function extractGeminiError(payload: unknown): string {
  if (typeof payload === "object" && payload && "error" in payload) {
    const error = (payload as { error?: { message?: string } }).error;
    if (error?.message) {
      return error.message;
    }
  }

  return "Gemini request failed";
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
  error?: { message?: string };
}

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(body)
  };
}
