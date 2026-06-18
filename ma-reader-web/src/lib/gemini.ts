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
  const text = await requestGemini(apiKey, page.imageDataUrl, prompt, "application/json", signal);
  return parseGeminiJson(text, page.pageNumber);
}

export async function convertPagesWithGemini(
  apiKey: string,
  pages: SourcePage[],
  options: ConvertOptions,
  signal?: AbortSignal
): Promise<GeminiPageResult[]> {
  if (pages.length === 1) {
    return [await convertPageWithGemini(apiKey, pages[0], options, signal)];
  }

  const prompt = buildBatchPrompt(pages.map((page) => page.pageNumber), options);
  const text = await requestGeminiImages(apiKey, pages.map((page) => page.imageDataUrl), prompt, "application/json", signal);
  return parseGeminiBatchJson(text, pages.map((page) => page.pageNumber));
}

export async function rescuePageTextWithGemini(
  apiKey: string,
  page: SourcePage,
  signal?: AbortSignal
): Promise<GeminiPageResult> {
  const prompt = `استخرج النص الظاهر في الصفحة رقم ${page.pageNumber} كنص خام فقط.
لا تضف شرحًا، ولا Markdown، ولا JSON، ولا تنسيقًا بصريًا.
حافظ على التشكيل العربي الظاهر ولا تضف تشكيلًا غير موجود.
اختصر سلاسل النقاط أو الشرطات الطويلة إلى ثلاث نقاط فقط: ...`;
  const text = await requestGemini(apiKey, page.imageDataUrl, prompt, "text/plain", signal);

  return resultFromPlainText(text, page.pageNumber, "تم استخدام إنقاذ نصي بعد فشل JSON.");
}

export async function askGemini(
  apiKey: string,
  prompt: string,
  imageDataUrls: string[] = [],
  signal?: AbortSignal
): Promise<string> {
  const response = await fetch("/.netlify/functions/gemini", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey, prompt, imageDataUrls, responseMimeType: "text/plain" }),
    signal
  });

  const payload = (await response.json().catch(() => null)) as { text?: string; error?: string } | null;
  if (!response.ok) {
    throw new Error(payload?.error || "فشل سؤال Gemini.");
  }

  if (!payload?.text) {
    throw new Error("لم يرجع Gemini إجابة.");
  }

  return payload.text;
}

async function requestGemini(
  apiKey: string,
  imageDataUrl: string,
  prompt: string,
  responseMimeType: "application/json" | "text/plain",
  signal?: AbortSignal
): Promise<string> {
  const response = await fetch("/.netlify/functions/gemini", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey, imageDataUrl, prompt, responseMimeType }),
    signal
  });

  const payload = (await response.json().catch(() => null)) as { text?: string; error?: string } | null;
  if (!response.ok) {
    throw new Error(payload?.error || "فشل الاتصال بخدمة Gemini.");
  }

  if (!payload?.text) {
    throw new Error("لم يرجع Gemini نصًا صالحًا.");
  }

  return payload.text;
}

async function requestGeminiImages(
  apiKey: string,
  imageDataUrls: string[],
  prompt: string,
  responseMimeType: "application/json" | "text/plain",
  signal?: AbortSignal
): Promise<string> {
  const response = await fetch("/.netlify/functions/gemini", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey, imageDataUrls, prompt, responseMimeType }),
    signal
  });

  const payload = (await response.json().catch(() => null)) as { text?: string; error?: string } | null;
  if (!response.ok) {
    throw new Error(payload?.error || "فشل الاتصال بخدمة Gemini.");
  }

  if (!payload?.text) {
    throw new Error("لم يرجع Gemini نصًا صالحًا.");
  }

  return payload.text;
}

export function buildPrompt(pageNumber: number, options: ConvertOptions): string {
  const detail = modeInstruction(options.conversionMode);
  const textModeInstruction = options.outputMode === "text"
    ? "وضع TXT: لا تستخرج أو تضف أي تنسيق بصري مثل bold أو italic أو underline أو font_size أو bbox."
    : "وضع Word: يمكن استخدام runs للحفاظ على الغامق والمائل والتسطير وحجم الخط عندما تكون ظاهرة بوضوح في الأصل. اجعل التسطير على نفس الكلمة أو العبارة فقط. استخدم role للعناوين والقوائم والمحاذاة الواضحة فقط.";
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
    { "text": "نص فقرة أو عنوان", "role": "paragraph", "level": 0, "alignment": "right", "font_size": 14, "runs": [{ "text": "جزء من النص", "bold": false, "italic": false, "underline": false, "font_size": 14 }] }
  ],
  "tables": [{ "rows": [["خلية", "خلية"]] }],
  "image_descriptions": ["وصف اختياري"]
}
إذا لم توجد جداول اجعل tables مصفوفة فارغة. إذا لم توجد أوصاف صور اجعل image_descriptions مصفوفة فارغة.`;
}

function buildBatchPrompt(pageNumbers: number[], options: ConvertOptions): string {
  const detail = modeInstruction(options.conversionMode);
  const textModeInstruction = options.outputMode === "text"
    ? "وضع TXT: لا تستخرج أو تضف أي تنسيق بصري مثل bold أو italic أو underline أو font_size أو bbox."
    : "وضع Word: يمكن استخدام runs للحفاظ على الغامق والمائل والتسطير وحجم الخط عندما تكون ظاهرة بوضوح في الأصل. اجعل التسطير على نفس الكلمة أو العبارة فقط. استخدم role للعناوين والقوائم والمحاذاة الواضحة فقط.";
  const imageInstruction = options.includeImageDescriptions
    ? "إذا وجدت صورة أو رسمًا مهمًا، أضف وصفًا موجزًا له في image_descriptions."
    : "لا تضف أوصاف صور ولا تكتب عبارات بديلة مثل صورة مدمجة أو صورة من الصفحة.";

  return `أنت محرك OCR عربي دقيق. الصور المرفقة تمثل الصفحات التالية بنفس ترتيب الإرفاق: ${pageNumbers.join(", ")}.

${detail}
${textModeInstruction}
${imageInstruction}

قواعد مهمة:
- استخرج كل صفحة مستقلة، ولا تخلط نص صفحة بصفحة أخرى.
- حافظ على النص العربي والتشكيل الظاهر حرفيًا، ولا تضف تشكيلًا غير ظاهر.
- لا تضف محتوى غير موجود في الصور.
- لا تكتب مقدمات أو شروحًا خارج JSON.
- إذا وجدت سلسلة نقاط أو شرطات أو خطوط طويلة للحشو، اختصرها إلى ثلاث نقاط فقط: ...
- لا تستخدم markdown code fences.

أعد JSON فقط بهذا الشكل:
{
  "pages": [
    {
      "page_number": ${pageNumbers[0]},
      "text_blocks": [
        { "text": "نص فقرة أو عنوان", "role": "paragraph", "level": 0, "alignment": "right", "font_size": 14, "runs": [{ "text": "جزء من النص", "bold": false, "italic": false, "underline": false, "font_size": 14 }] }
      ],
      "tables": [{ "rows": [["خلية", "خلية"]] }],
      "image_descriptions": ["وصف اختياري"]
    }
  ]
}

يجب أن تحتوي pages على نتيجة لكل صفحة من هذه الصفحات: ${pageNumbers.join(", ")}.
إذا لم توجد جداول في صفحة اجعل tables مصفوفة فارغة. إذا لم توجد أوصاف صور اجعل image_descriptions مصفوفة فارغة.`;
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
    return resultFromPlainText(text, pageNumber, "لم يرجع Gemini JSON واضحًا؛ تم إنقاذ النص الخام.");
  }

  const jsonText = text.slice(start, end + 1);
  let parsed: GeminiPageResult;
  try {
    parsed = parseJsonWithRepair(jsonText) as GeminiPageResult;
  } catch {
    return resultFromPlainText(text, pageNumber, "فشل JSON حتى بعد محاولة الإصلاح؛ تم إنقاذ النص الخام.");
  }

  return normalizeGeminiResult(parsed, pageNumber);
}

function parseGeminiBatchJson(rawText: string, pageNumbers: number[]): GeminiPageResult[] {
  const text = sanitizeJsonText(stripCodeFence(rawText));
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start < 0 || end <= start) {
    throw new Error("لم يرجع Gemini JSON واضحًا لدفعة الصفحات.");
  }

  const parsed = parseJsonWithRepair(text.slice(start, end + 1)) as { pages?: GeminiPageResult[] } | GeminiPageResult[];
  const rawPages = Array.isArray(parsed) ? parsed : parsed.pages;
  if (!Array.isArray(rawPages)) {
    throw new Error("رد Gemini لا يحتوي على مصفوفة pages.");
  }

  const normalized = rawPages.map((page) => normalizeGeminiResult(page, Number(page.page_number)));
  const byNumber = new Map(normalized.map((page) => [page.page_number, page]));
  return pageNumbers.map((pageNumber) => {
    const page = byNumber.get(pageNumber);
    if (!page) {
      throw new Error(`لم يرجع Gemini نتيجة الصفحة ${pageNumber} داخل الدفعة.`);
    }
    return page;
  });
}

function parseJsonWithRepair(jsonText: string): unknown {
  const candidates = [
    jsonText,
    jsonText.replace(/,\s*([}\]])/g, "$1"),
    balanceJson(jsonText.replace(/,\s*([}\]])/g, "$1"))
  ];

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }

  throw new Error("تعذر تحليل JSON بعد محاولة الإصلاح.");
}

function balanceJson(value: string): string {
  let text = value;
  const openBraces = (text.match(/{/g) ?? []).length;
  const closeBraces = (text.match(/}/g) ?? []).length;
  const openBrackets = (text.match(/\[/g) ?? []).length;
  const closeBrackets = (text.match(/]/g) ?? []).length;

  if ((text.match(/"/g) ?? []).length % 2 === 1) {
    text += '"';
  }

  text += "]".repeat(Math.max(0, openBrackets - closeBrackets));
  text += "}".repeat(Math.max(0, openBraces - closeBraces));
  return text;
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

export function resultFromPlainText(text: string, pageNumber: number, warning: string): GeminiPageResult {
  const cleaned = normalizeText(stripCodeFence(text));
  return {
    page_number: pageNumber,
    text_blocks: cleaned ? [{ text: cleaned }] : [],
    tables: [],
    image_descriptions: [],
    warnings: [warning]
  };
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
              underline: Boolean(run?.underline),
              font_size: normalizeFontSize(run?.font_size)
            })).filter((run) => run.text.length > 0)
          : undefined,
        role: normalizeRole(block?.role),
        level: normalizeLevel(block?.level),
        alignment: normalizeAlignment(block?.alignment),
        font_size: normalizeFontSize(block?.font_size)
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

function normalizeRole(value: unknown): "heading" | "paragraph" | "list_item" | undefined {
  return value === "heading" || value === "paragraph" || value === "list_item" ? value : undefined;
}

function normalizeAlignment(value: unknown): "right" | "center" | "left" | undefined {
  return value === "right" || value === "center" || value === "left" ? value : undefined;
}

function normalizeLevel(value: unknown): number | undefined {
  const level = Number(value);
  return Number.isFinite(level) ? Math.min(Math.max(Math.round(level), 0), 6) : undefined;
}

function normalizeFontSize(value: unknown): number | undefined {
  const fontSize = Number(value);
  return Number.isFinite(fontSize) ? Math.min(Math.max(Math.round(fontSize), 8), 36) : undefined;
}
