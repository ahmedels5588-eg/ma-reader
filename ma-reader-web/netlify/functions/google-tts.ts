import type { Handler } from "@netlify/functions";

const GOOGLE_TTS_ENDPOINT = "https://texttospeech.googleapis.com/v1/text:synthesize";

interface GoogleTtsRequestBody {
  apiKey?: string;
  text?: string;
  voiceName?: string;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  let body: GoogleTtsRequestBody;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const apiKey = body.apiKey?.trim();
  const text = body.text?.trim();
  const voiceName = body.voiceName || "ar-XA-Standard-A";

  if (!apiKey || !text) {
    return json(400, { error: "Missing apiKey or text" });
  }

  try {
    const response = await fetch(GOOGLE_TTS_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        input: { text },
        voice: {
          languageCode: "ar-XA",
          name: voiceName
        },
        audioConfig: {
          audioEncoding: "LINEAR16",
          sampleRateHertz: 24000,
          speakingRate: 1.0
        }
      })
    });

    const payload = await response.json().catch(() => null) as GoogleTtsResponse | null;
    if (!response.ok) {
      return json(response.status, { error: extractGoogleError(payload) });
    }

    if (!payload?.audioContent) {
      return json(502, { error: "Google Cloud TTS returned no audio" });
    }

    return json(200, {
      audioBase64: payload.audioContent,
      mimeType: "audio/L16;codec=pcm;rate=24000"
    });
  } catch {
    return json(502, { error: "Failed to contact Google Cloud TTS" });
  }
};

function extractGoogleError(payload: unknown): string {
  if (typeof payload === "object" && payload && "error" in payload) {
    const error = (payload as { error?: { message?: string } }).error;
    if (error?.message) {
      return error.message;
    }
  }

  return "Google Cloud TTS request failed";
}

interface GoogleTtsResponse {
  audioContent?: string;
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
