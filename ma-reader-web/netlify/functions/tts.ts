import type { Handler } from "@netlify/functions";

const TTS_MODEL = "gemini-2.5-flash-preview-tts";
const TTS_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent`;

interface TtsRequestBody {
  apiKey?: string;
  text?: string;
  voiceName?: string;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  let body: TtsRequestBody;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const apiKey = body.apiKey?.trim();
  const text = body.text?.trim();
  const voiceName = body.voiceName || "Kore";

  if (!apiKey || !text) {
    return json(400, { error: "Missing apiKey or text" });
  }

  try {
    const response = await fetch(TTS_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text }]
          }
        ],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName }
            }
          }
        }
      })
    });

    const payload = await response.json().catch(() => null) as GeminiTtsResponse | null;
    if (!response.ok) {
      return json(response.status, { error: extractGeminiError(payload) });
    }

    const inlineData = payload?.candidates?.[0]?.content?.parts
      ?.map((part) => part.inlineData || part.inline_data)
      .find(Boolean);

    if (!inlineData?.data) {
      return json(502, { error: "Gemini TTS returned no audio" });
    }

    return json(200, {
      audioBase64: inlineData.data,
      mimeType: inlineMimeType(inlineData) || "audio/L16;codec=pcm;rate=24000"
    });
  } catch {
    return json(502, { error: "Failed to contact Gemini TTS" });
  }
};

function inlineMimeType(value: { mimeType?: string; mime_type?: string }): string | undefined {
  return value.mimeType || value.mime_type;
}

function extractGeminiError(payload: unknown): string {
  if (typeof payload === "object" && payload && "error" in payload) {
    const error = (payload as { error?: { message?: string } }).error;
    if (error?.message) {
      return error.message;
    }
  }

  return "Gemini TTS request failed";
}

interface GeminiTtsResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        inlineData?: { data?: string; mimeType?: string };
        inline_data?: { data?: string; mime_type?: string };
      }>;
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
