import type { ConversionMode, ConvertOptions, GeminiPageResult, SourcePage } from "./types";

const LONG_DOTS_RE = /\.{10,}/g;
const LONG_UNDERSCORE_RE = /_{10,}/g;
const LONG_DASH_RE = /[-ـ]{10,}/g;

export async function convertPageWithGemini(
  apiKey: string,
  page: SourcePage,
  options: ConvertOptions,
  signal?: AbortSignal
): Promise<GeminiPageResult> {
  const prompt = buildPrompt(page.pageNumber, options);
  const response = await fetch("/.netlify/functions/gemini", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey, imageDataUrl: page.imageDataUrl, prompt }),
    signal
  });

  const payload = (await response.json().catch(() => null)) as { text?: string; error?: string } | null;
  if (!response.ok) {
    throw new Error(payload?.error || "فشل الاتصال بخدمة Gemini.");
  }

  if (!payload?.text) {
    throw new Error("لم يرجع Gemini نصًا صالحًا.");
  }

  return parseGeminiJson(payload.text, page.pageNumber);
}

export function buildPrompt(pageNumber: number, options: ConvertOptions): string {
  const detail = modeInstruction(options.conversionMode);
  const textModeInstruction = options.outputMode === "text"
    ? "وضع TXT: لا تستخرج أو تضف أي تنسيق بصري مثل bold أو italic أو underline أو font_size أو bbox."
    : "وضع Word: يمكن استخدام runs للحفاظ على الغامق والمائل والتسطير فقط عندما تكون ظاهرة بوضوح في الأصل. اجعل التسطير على نفس الكلمة أو العبارة فقط.";
  const imageInstruction = options.includeImageDescriptions
    ? "إذا وجدت صورة أو رسمًا مهمًا، أضف وصفًا موجزًا له في image_descriptions."
    : "لا تضف أوصاف صور ولا تكتب عبارات بديلة مثل صورة مدمجة أو صورة من الصفحة.";

  return `أنت محرك OCR عربي دقيق. استخرج محتوى الصفحة رقم ${pageNumber} من الصورة المرفقة فقط.

${detail}
${textModeInstruction}
${imageInstruction}

قواعد مهمة:
- حافظ على النص العربي والتشكيل الظاهر حرفيًا، ولا تضف تشكيلًا غير ظاهر.
- لا تضف محتوى غير موجود في الصفحة.
- لا تكتب مقدمات أو شروحًا خارج JSON.
- إذا وجدت سلسلة نقاط أو شرطات أو خطوط طويلة للحشو، اختصرها إلى ثلاث نقاط فقط: ...
- لا تستخدم markdown code fences.

أعد JSON فقط بهذا الشكل:
{
  "page_number": ${pageNumber},
  "text_blocks": [
    { "text": "نص فقرة أو عنوان", "runs": [{ "text": "جزء من النص", "bold": false, "italic": false, "underline": false }] }
  ],
  "tables": [{ "rows": [["خلية", "خلية"]] }],
  "image_descriptions": ["وصف اختياري"]
}

إذا لم توجد جداول اجعل tables مصفوفة فارغة. إذا لم توجد أوصاف صور اجعل image_descriptions مصفوفة فارغة.`;
}

function modeInstruction(mode: ConversionMode): string {
  if (mode === "fast") {
    return "وضع سريع: ركز على النص الأساسي وترتيب الفقرات والجداول الواضحة.";
  }

  if (mode === "advanced") {
    return "وضع متقدم: دقق في العناوين، الهوامش، الجداول، التشكيل، وعلامات الترقيم قدر الإمكان دون اختراع تنسيق.";
  }

  return "وضع متوازن: استخرج النص والجداول الواضحة مع الحفاظ على ترتيب القراءة العربي.";
}

function parseGeminiJson(rawText: string, pageNumber: number): GeminiPageResult {
  const text = sanitizeJsonText(stripCodeFence(rawText));
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start < 0 || end <= start) {
    throw new Error("تعذر العثور على JSON في رد Gemini.");
  }

  const jsonText = text.slice(start, end + 1);
  const parsed = JSON.parse(jsonText) as GeminiPageResult;

  return normalizeGeminiResult(parsed, pageNumber);
}

function stripCodeFence(value: string): string {
  return value
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "");
}

function sanitizeJsonText(value: string): string {
  return value
    .replace(LONG_DOTS_RE, "...")
    .replace(LONG_UNDERSCORE_RE, "...")
    .replace(LONG_DASH_RE, "...")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

function normalizeText(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .replace(LONG_DOTS_RE, "...")
    .replace(LONG_UNDERSCORE_RE, "...")
    .replace(LONG_DASH_RE, "...")
    .trim();
}

function normalizeGeminiResult(value: GeminiPageResult, pageNumber: number): GeminiPageResult {
  const textBlocks = Array.isArray(value.text_blocks) ? value.text_blocks : [];
  const tables = Array.isArray(value.tables) ? value.tables : [];
  const imageDescriptions = Array.isArray(value.image_descriptions) ? value.image_descriptions : [];

  return {
    page_number: pageNumber,
    text_blocks: textBlocks
      .map((block) => ({
        text: normalizeText(block?.text),
        runs: Array.isArray(block?.runs)
          ? block.runs.map((run) => ({
              text: normalizeText(run?.text),
              bold: Boolean(run?.bold),
              italic: Boolean(run?.italic),
              underline: Boolean(run?.underline)
            })).filter((run) => run.text.length > 0)
          : undefined
      }))
      .filter((block) => block.text.length > 0 || (block.runs?.length ?? 0) > 0),
    tables: tables
      .map((table) => ({
        rows: Array.isArray(table?.rows)
          ? table.rows.map((row) => Array.isArray(row) ? row.map(normalizeText) : []).filter((row) => row.length > 0)
          : []
      }))
      .filter((table) => table.rows.length > 0),
    image_descriptions: imageDescriptions.map(normalizeText).filter(Boolean),
    warnings: Array.isArray(value.warnings) ? value.warnings.map(normalizeText).filter(Boolean) : []
  };
}
