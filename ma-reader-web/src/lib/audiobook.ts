export interface TtsAudioSegment {
  audioBase64: string;
  mimeType: string;
}

export type TtsProvider = "google" | "gemini";

export async function synthesizeSpeech(
  apiKey: string,
  text: string,
  provider: TtsProvider,
  signal?: AbortSignal
): Promise<TtsAudioSegment> {
  const endpoint = provider === "google" ? "/.netlify/functions/google-tts" : "/.netlify/functions/tts";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey, text, voiceName: provider === "google" ? "ar-XA-Standard-A" : "Kore" }),
    signal
  });

  const payload = (await response.json().catch(() => null)) as Partial<TtsAudioSegment> & { error?: string } | null;
  if (!response.ok) {
    throw new Error(payload?.error || "فشل إنشاء الصوت.");
  }

  if (!payload?.audioBase64 || !payload.mimeType) {
    throw new Error("لم يرجع مزود الصوت نتيجة صالحة.");
  }

  return { audioBase64: payload.audioBase64, mimeType: payload.mimeType };
}

export async function testGoogleCloudTts(apiKey: string, signal?: AbortSignal): Promise<void> {
  await synthesizeSpeech(apiKey, "اختبار", "google", signal);
}

export async function testGeminiTts(apiKey: string, signal?: AbortSignal): Promise<void> {
  await synthesizeSpeech(apiKey, "اختبار", "gemini", signal);
}

export function splitTextForTts(text: string, maxLength = 1800): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return [];
  }

  const chunks: string[] = [];
  let remaining = normalized;

  while (remaining.length > maxLength) {
    const slice = remaining.slice(0, maxLength);
    const breakAt = Math.max(
      slice.lastIndexOf(". "),
      slice.lastIndexOf("؟ "),
      slice.lastIndexOf("! "),
      slice.lastIndexOf("، "),
      slice.lastIndexOf("؛ ")
    );
    const cut = breakAt > 400 ? breakAt + 1 : maxLength;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

export function ttsSegmentsToWavBlob(segments: TtsAudioSegment[]): Blob {
  if (segments.length === 0) {
    return new Blob([], { type: "audio/wav" });
  }

  const sampleRate = parseSampleRate(segments[0].mimeType);
  const pcmParts = segments.map((segment) => stripWavHeaderIfPresent(base64ToUint8Array(segment.audioBase64)));
  const totalLength = pcmParts.reduce((sum, part) => sum + part.length, 0);
  const pcm = new Uint8Array(totalLength);
  let offset = 0;

  for (const part of pcmParts) {
    pcm.set(part, offset);
    offset += part.length;
  }

  return new Blob([wavHeader(pcm.length, sampleRate), pcm], { type: "audio/wav" });
}

function parseSampleRate(mimeType: string): number {
  const match = /rate=(\d+)/i.exec(mimeType);
  return match ? Number(match[1]) : 24000;
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function stripWavHeaderIfPresent(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 44 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
    return bytes;
  }

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkId = ascii(bytes, offset, 4);
    const chunkSize = bytes[offset + 4] | (bytes[offset + 5] << 8) | (bytes[offset + 6] << 16) | (bytes[offset + 7] << 24);
    const dataStart = offset + 8;
    if (chunkId === "data") {
      return bytes.slice(dataStart, dataStart + chunkSize);
    }
    offset = dataStart + chunkSize;
  }

  return bytes;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(bytes[offset + index]);
  }
  return value;
}

function wavHeader(dataLength: number, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataLength, true);

  return buffer;
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}
