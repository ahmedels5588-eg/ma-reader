import { useEffect, useRef, useState } from "react";
import { summarizeProgress } from "./lib/accessibility";
import { buildDocx, buildErrorReport, buildPlainText, downloadBlob } from "./lib/docxBuilder";
import { askGemini, convertPageWithGemini, rescuePageTextWithGemini, resultFromPlainText } from "./lib/gemini";
import { filesToSourcePages } from "./lib/pdf";
import { deleteApiKey, loadApiKeys, loadSettings, normalizeApiKeys, saveApiKeys, saveSettings } from "./lib/storage";
import type { AppSettings, ConversionMode, ConvertOptions, OutputMode, PageResult, SourcePage } from "./lib/types";

const REQUEST_DELAY_MS = 1200;
const MAX_ATTEMPTS_PER_KEY = 2;

export default function App() {
  const [apiKeys, setApiKeys] = useState<string[]>([]);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiKeyTestStatus, setApiKeyTestStatus] = useState("");
  const [testingKey, setTestingKey] = useState(false);
  const [activeKeyIndex, setActiveKeyIndex] = useState(0);
  const [pages, setPages] = useState<SourcePage[]>([]);
  const [results, setResults] = useState<PageResult[]>([]);
  const [outputMode, setOutputMode] = useState<OutputMode>("word");
  const [conversionMode, setConversionMode] = useState<ConversionMode>("balanced");
  const [includeImageDescriptions, setIncludeImageDescriptions] = useState(false);
  const [includeEmbeddedImages, setIncludeEmbeddedImages] = useState(false);
  const [pageFrom, setPageFrom] = useState(1);
  const [pageTo, setPageTo] = useState(1);
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("جاهز.");
  const [assertiveMessage, setAssertiveMessage] = useState("");
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [lastSearchIndex, setLastSearchIndex] = useState(-1);
  const [askQuestion, setAskQuestion] = useState("");
  const [askAnswer, setAskAnswer] = useState("");
  const [askHistory, setAskHistory] = useState<Array<{ question: string; answer: string }>>([]);
  const [askBusy, setAskBusy] = useState(false);
  const stopRequested = useRef(false);
  const abortController = useRef<AbortController | null>(null);
  const apiKeysRef = useRef<HTMLInputElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const askRef = useRef<HTMLTextAreaElement | null>(null);
  const previewRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const storedApiKeys = loadApiKeys();
    const settings = loadSettings();
    setApiKeys(storedApiKeys);
    setOutputMode(settings.outputMode ?? "word");
    setConversionMode(settings.conversionMode ?? "balanced");
    setIncludeImageDescriptions(Boolean(settings.includeImageDescriptions));
    setIncludeEmbeddedImages(Boolean(settings.includeEmbeddedImages));
    setPageFrom(Math.max(1, Number(settings.pageFrom ?? 1)));
    setPageTo(Math.max(1, Number(settings.pageTo ?? 1)));
    setPrivacyAccepted(Boolean(settings.privacyAccepted));
  }, []);

  useEffect(() => {
    const settings: AppSettings = {
      outputMode,
      conversionMode,
      includeImageDescriptions,
      includeEmbeddedImages,
      pageFrom,
      pageTo,
      privacyAccepted
    };
    saveSettings(settings);
  }, [outputMode, conversionMode, includeImageDescriptions, includeEmbeddedImages, pageFrom, pageTo, privacyAccepted]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.ctrlKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        apiKeysRef.current?.focus();
      }

      if (event.ctrlKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchRef.current?.focus();
      }

      if (event.key === "F3") {
        event.preventDefault();
        findInPreview(event.shiftKey ? "previous" : "next");
      }

      if (event.ctrlKey && event.key.toLowerCase() === "g") {
        event.preventDefault();
        const value = window.prompt("اكتب رقم الصفحة للانتقال إليها:");
        if (value) {
          goToPage(Number(value));
        }
      }

      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "q") {
        event.preventDefault();
        askRef.current?.focus();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  const doneCount = results.filter((result) => result.status === "done").length;
  const failedCount = results.filter((result) => result.status === "failed").length;
  const progressText = summarizeProgress(doneCount, failedCount, results.length || pages.length);
  const hasSuccessfulPages = results.some((result) => result.status === "done");
  const hasFailedPages = results.some((result) => result.status === "failed");
  const safePageFrom = clampPage(pageFrom, pages.length);
  const safePageTo = clampPage(pageTo, pages.length);
  const selectedRangeStart = Math.min(safePageFrom, safePageTo);
  const selectedRangeEnd = Math.max(safePageFrom, safePageTo);
  const previewText = buildPreviewText(results);
  const safeActiveKeyIndex = apiKeys.length > 0 ? Math.min(activeKeyIndex, apiKeys.length - 1) : 0;

  async function handleAddApiKey() {
    const key = apiKeyInput.trim();
    if (!key) {
      setAssertiveMessage("أدخل مفتاح Gemini API أولًا.");
      return;
    }

    if (apiKeys.includes(key)) {
      setAssertiveMessage("هذا المفتاح محفوظ بالفعل.");
      return;
    }

    try {
      await testApiKey(key);
      persistApiKeys([...apiKeys, key], apiKeys.length);
      setMessage(`تم اختبار المفتاح وقبوله. عدد المفاتيح المحفوظة الآن: ${apiKeys.length + 1}.`);
    } catch (error) {
      rejectApiKey(error);
    }
  }

  async function handleReplaceCurrentApiKey() {
    const key = apiKeyInput.trim();
    if (!key) {
      setAssertiveMessage("أدخل مفتاح Gemini API الجديد أولًا.");
      return;
    }

    if (apiKeys.length === 0) {
      await handleAddApiKey();
      return;
    }

    if (apiKeys.some((savedKey, index) => savedKey === key && index !== safeActiveKeyIndex)) {
      setAssertiveMessage("هذا المفتاح موجود بالفعل ضمن المفاتيح المحفوظة.");
      return;
    }

    try {
      await testApiKey(key);
      const nextKeys = [...apiKeys];
      nextKeys[safeActiveKeyIndex] = key;
      persistApiKeys(nextKeys, safeActiveKeyIndex);
      setMessage(`تم اختبار المفتاح وقبوله واستبدال المفتاح رقم ${safeActiveKeyIndex + 1}.`);
    } catch (error) {
      rejectApiKey(error);
    }
  }

  async function testApiKey(key: string) {
    setTestingKey(true);
    setApiKeyTestStatus("جاري اختبار المفتاح مع Gemini...");
    try {
      await askGemini(key, "اختبار مفتاح API. أجب بكلمة OK فقط.");
      setApiKeyTestStatus("تم التأكد من أن مفتاح API صحيح وتم قبوله.");
    } finally {
      setTestingKey(false);
    }
  }

  function rejectApiKey(error: unknown) {
    const message = error instanceof Error ? error.message : "فشل اختبار مفتاح API.";
    setApiKeyTestStatus(`تم رفض المفتاح: ${message}`);
    setAssertiveMessage("تم رفض مفتاح API لأنه لم يجتز الاختبار.");
  }

  function persistApiKeys(nextKeys: string[], nextActiveIndex: number) {
    const normalizedKeys = normalizeApiKeys(nextKeys);
    saveApiKeys(normalizedKeys);
    setApiKeys(normalizedKeys);
    setApiKeyInput("");
    setActiveKeyIndex(normalizedKeys.length > 0 ? Math.min(nextActiveIndex, normalizedKeys.length - 1) : 0);
  }

  function handleDeleteCurrentApiKey() {
    if (apiKeys.length === 0) {
      setAssertiveMessage("لا توجد مفاتيح محفوظة لحذفها.");
      return;
    }

    const nextKeys = apiKeys.filter((_, index) => index !== safeActiveKeyIndex);
    persistApiKeys(nextKeys, Math.max(0, safeActiveKeyIndex - 1));
    if (nextKeys.length === 0) {
      deleteApiKey();
    }

    setMessage("تم حذف المفتاح الحالي من هذا المتصفح.");
  }

  function handleDeleteAllApiKeys() {
    deleteApiKey();
    setApiKeys([]);
    setApiKeyInput("");
    setActiveKeyIndex(0);
    setApiKeyTestStatus("");
    setMessage("تم حذف كل مفاتيح API من هذا المتصفح.");
  }

  async function handleFilesSelected(fileList: FileList | null) {
    if (!fileList?.length) {
      return;
    }

    setLoadingFiles(true);
    setMessage("جاري تجهيز الصفحات داخل المتصفح...");

    try {
      const extractedPages = await filesToSourcePages(Array.from(fileList));
      setPages(extractedPages);
      setResults(extractedPages.map((page) => ({ page, status: "pending" })));
      setPageFrom(1);
      setPageTo(Math.max(1, extractedPages.length));
      setMessage(`تم تجهيز ${extractedPages.length} صفحة. لم يتم رفع ملف PDF كامل إلى الخادم.`);
    } catch (error) {
      setAssertiveMessage(error instanceof Error ? error.message : "فشل تجهيز الملفات.");
    } finally {
      setLoadingFiles(false);
    }
  }

  async function startConversion(onlyFailed: boolean) {
    if (apiKeys.length === 0) {
      setAssertiveMessage("أدخل مفتاح Gemini API واحدًا على الأقل قبل بدء التحويل.");
      return;
    }

    if (pages.length === 0) {
      setAssertiveMessage("اختر PDF أو صورًا أولًا.");
      return;
    }

    if (!privacyAccepted) {
      const accepted = window.confirm("تنبيه خصوصية: سيتم إرسال صورة الصفحة الحالية فقط إلى Gemini لاستخراج النص. لا تستخدم ملفات سرية إلا إذا كنت موافقًا على إرسال محتواها لخدمة خارجية. هل تريد المتابعة؟");
      if (!accepted) {
        setMessage("تم إلغاء التحويل بسبب عدم قبول تنبيه الخصوصية.");
        return;
      }

      setPrivacyAccepted(true);
    }

    const initialResults = results.length === pages.length
      ? results
      : pages.map((page) => ({ page, status: "pending" as const }));
    const targetIndexes = initialResults
      .map((result, index) => ({ result, index }))
      .filter(({ result, index }) => {
        const pageNumber = pages[index].pageNumber;
        const inRange = pageNumber >= selectedRangeStart && pageNumber <= selectedRangeEnd;
        return inRange && (onlyFailed ? result.status === "failed" : result.status !== "done");
      })
      .map(({ index }) => index);

    if (targetIndexes.length === 0) {
      setMessage("لا توجد صفحات تحتاج إلى تحويل داخل النطاق المحدد.");
      return;
    }

    setResults(initialResults);
    setBusy(true);
    stopRequested.current = false;
    setAssertiveMessage(onlyFailed ? "بدأت إعادة محاولة الصفحات الفاشلة." : "بدأ التحويل.");

    const options: ConvertOptions = { outputMode, conversionMode, includeImageDescriptions, includeEmbeddedImages };
    let workingResults = initialResults;

    try {
      for (const index of targetIndexes) {
        if (stopRequested.current) {
          workingResults = updateResult(workingResults, index, { status: "skipped", error: "تم الإيقاف قبل معالجة الصفحة." });
          setResults(workingResults);
          continue;
        }

        abortController.current = new AbortController();
        workingResults = updateResult(workingResults, index, { status: "processing", error: undefined });
        setResults(workingResults);
        setMessage(`جاري تحويل الصفحة ${pages[index].pageNumber} من ${pages.length} باستخدام مفتاح ${activeKeyIndex + 1} من ${apiKeys.length}...`);

        try {
          const data = await convertWithResilience(pages[index], options, abortController.current.signal);
          workingResults = updateResult(workingResults, index, { status: "done", data, error: undefined });
        } catch (error) {
          const fallback = fallbackFromLocalText(pages[index], error);
          if (fallback) {
            workingResults = updateResult(workingResults, index, { status: "done", data: fallback, error: undefined });
          } else {
            const errorMessage = error instanceof Error ? error.message : "فشل غير معروف.";
            workingResults = updateResult(workingResults, index, { status: "failed", error: errorMessage });
          }
        }

        setResults(workingResults);

        if (!stopRequested.current && index !== targetIndexes[targetIndexes.length - 1]) {
          await delay(REQUEST_DELAY_MS);
        }
      }
    } finally {
      abortController.current = null;
      setBusy(false);
      setAssertiveMessage("انتهت المعالجة. يمكنك تنزيل النتيجة أو إعادة محاولة الصفحات الفاشلة.");
    }
  }

  async function convertWithResilience(page: SourcePage, options: ConvertOptions, signal?: AbortSignal) {
    let lastError: unknown;
    const orderedKeys = rotateKeys(apiKeys, activeKeyIndex);

    for (let keyOffset = 0; keyOffset < orderedKeys.length; keyOffset += 1) {
      const key = orderedKeys[keyOffset];
      const realIndex = apiKeys.indexOf(key);
      setActiveKeyIndex(realIndex >= 0 ? realIndex : 0);

      for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_KEY; attempt += 1) {
        if (stopRequested.current) {
          throw new Error("تم إيقاف التحويل.");
        }

        try {
          return await convertPageWithGemini(key, page, options, signal);
        } catch (error) {
          lastError = error;
          if (isQuotaOrKeyError(error)) {
            break;
          }

          try {
            return await rescuePageTextWithGemini(key, page, signal);
          } catch (rescueError) {
            lastError = rescueError;
          }

          if (attempt < MAX_ATTEMPTS_PER_KEY) {
            await delay(1500 * attempt);
          }
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error("فشلت كل محاولات Gemini.");
  }

  function stopConversion() {
    stopRequested.current = true;
    abortController.current?.abort();
    setMessage("تم طلب الإيقاف. لن تبدأ صفحات جديدة.");
  }

  async function handleDownload() {
    if (!hasSuccessfulPages) {
      setAssertiveMessage("لا توجد صفحات ناجحة للتنزيل.");
      return;
    }

    if (outputMode === "text") {
      downloadBlob(buildPlainText(results), "ma-reader-output.txt");
      return;
    }

    const blob = await buildDocx(results, includeEmbeddedImages && outputMode === "word");
    downloadBlob(blob, "ma-reader-output.docx");
  }

  function handleDownloadErrors() {
    if (!hasFailedPages) {
      setAssertiveMessage("لا توجد أخطاء لتنزيل تقرير عنها.");
      return;
    }

    downloadBlob(buildErrorReport(results), "ma-reader-errors.txt");
  }

  function findInPreview(direction: "next" | "previous") {
    const term = searchTerm.trim();
    const preview = previewRef.current;
    if (!term || !previewText || !preview) {
      setAssertiveMessage("اكتب نصًا للبحث أولًا.");
      return;
    }

    const haystack = previewText.toLocaleLowerCase("ar");
    const needle = term.toLocaleLowerCase("ar");
    let index = -1;

    if (direction === "next") {
      index = haystack.indexOf(needle, Math.max(0, lastSearchIndex + 1));
      if (index < 0) {
        index = haystack.indexOf(needle, 0);
      }
    } else {
      index = haystack.lastIndexOf(needle, Math.max(0, lastSearchIndex - 1));
      if (index < 0) {
        index = haystack.lastIndexOf(needle);
      }
    }

    if (index < 0) {
      setAssertiveMessage("لم يتم العثور على النص المطلوب.");
      return;
    }

    setLastSearchIndex(index);
    preview.focus();
    preview.setSelectionRange(index, index + term.length);
    setMessage("تم العثور على نتيجة بحث.");
  }

  function goToPage(pageNumber: number) {
    const preview = previewRef.current;
    if (!preview || !previewText) {
      setAssertiveMessage("لا توجد نتائج للانتقال داخلها.");
      return;
    }

    const marker = `=== الصفحة ${pageNumber} ===`;
    const index = previewText.indexOf(marker);
    if (index < 0) {
      setAssertiveMessage(`لم يتم العثور على الصفحة ${pageNumber} داخل النتائج الحالية.`);
      return;
    }

    preview.focus();
    preview.setSelectionRange(index, index + marker.length);
    setMessage(`تم الانتقال إلى الصفحة ${pageNumber}.`);
  }

  async function handleAskBook() {
    const question = askQuestion.trim();
    if (!question) {
      setAssertiveMessage("اكتب سؤالًا أولًا.");
      return;
    }

    if (apiKeys.length === 0) {
      setAssertiveMessage("أدخل مفتاح Gemini API قبل السؤال.");
      return;
    }

    if (!hasSuccessfulPages) {
      setAssertiveMessage("حوّل صفحة واحدة على الأقل قبل استخدام اسأل عن الكتاب.");
      return;
    }

    const visual = isVisualQuestion(question);
    const mentionedRange = parseMentionedPageRange(question);
    if (visual && !mentionedRange) {
      setAssertiveMessage("السؤال يبدو بصريًا ويحتاج تحديد صفحة أو نطاق. مثال: صف الصورة في الصفحة 5، أو حلل الصور من صفحة 1 إلى 3.");
      return;
    }

    const imagePages = visual && mentionedRange
      ? pages.filter((page) => page.pageNumber >= mentionedRange.from && page.pageNumber <= mentionedRange.to).slice(0, 6)
      : [];
    if (visual && imagePages.length === 0) {
      setAssertiveMessage("لم يتم العثور على صور الصفحات المطلوبة للسؤال البصري.");
      return;
    }

    setAskBusy(true);
    setAskAnswer("جاري سؤال Gemini...");

    try {
      const prompt = visual
        ? buildVisualAskPrompt(question, imagePages.map((page) => page.pageNumber))
        : buildTextAskPrompt(question, previewText);
      const answer = await askWithResilience(prompt, imagePages.map((page) => page.imageDataUrl));
      setAskAnswer(answer);
      setAskHistory((history) => [{ question, answer }, ...history].slice(0, 10));
      setMessage("تمت الإجابة عن السؤال.");
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "فشل السؤال.";
      setAskAnswer(errorMessage);
      setAssertiveMessage(errorMessage);
    } finally {
      setAskBusy(false);
    }
  }

  async function askWithResilience(prompt: string, imageDataUrls: string[]) {
    let lastError: unknown;
    const orderedKeys = rotateKeys(apiKeys, activeKeyIndex);

    for (const key of orderedKeys) {
      try {
        const realIndex = apiKeys.indexOf(key);
        setActiveKeyIndex(realIndex >= 0 ? realIndex : 0);
        return await askGemini(key, prompt, imageDataUrls);
      } catch (error) {
        lastError = error;
        if (!isQuotaOrKeyError(error)) {
          await delay(1000);
          try {
            return await askGemini(key, prompt, imageDataUrls);
          } catch (secondError) {
            lastError = secondError;
          }
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error("فشل سؤال Gemini بكل المفاتيح.");
  }

  return (
    <main className="app-shell" aria-labelledby="page-title">
      <section className="hero" aria-describedby="hero-description">
        <p className="eyebrow">MA Reader Web</p>
        <h1 id="page-title">تحويل PDF والصور العربية إلى Word أو TXT</h1>
        <p id="hero-description">
          يتم تحويل PDF إلى صور داخل المتصفح، ثم ترسل صورة الصفحة فقط إلى Gemini عبر Netlify Function. لا توجد قاعدة بيانات ولا تخزين لملفاتك على الخادم.
        </p>
      </section>

      <div className="status-region" aria-live="polite" aria-atomic="true">{message} {progressText}</div>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">{assertiveMessage}</div>

      <section className="card" aria-labelledby="api-title">
        <h2 id="api-title">1. مفاتيح Gemini API</h2>
        <label htmlFor="api-key">اكتب مفتاحًا جديدًا أو بديلًا</label>
        <input
          id="api-key"
          ref={apiKeysRef}
          type="password"
          autoComplete="off"
          value={apiKeyInput}
          onChange={(event) => setApiKeyInput(event.target.value)}
          placeholder="AIza..."
          disabled={testingKey || busy}
        />
        <div className="button-row">
          <button type="button" onClick={() => void handleAddApiKey()} disabled={testingKey || busy}>اختبار وإضافة مفتاح جديد</button>
          <button type="button" className="secondary" onClick={() => void handleReplaceCurrentApiKey()} disabled={testingKey || busy}>اختبار واستبدال الحالي</button>
          <button type="button" className="secondary" onClick={handleDeleteCurrentApiKey} disabled={testingKey || busy || apiKeys.length === 0}>حذف الحالي</button>
          <button type="button" className="secondary" onClick={handleDeleteAllApiKeys} disabled={testingKey || busy || apiKeys.length === 0}>حذف الكل</button>
          <a className="button-link" href="https://aistudio.google.com/app/api-keys" target="_blank" rel="noreferrer">الحصول على مفتاح</a>
        </div>
        {apiKeys.length > 0 && (
          <label>
            المفتاح الحالي المستخدم عند البدء
            <select value={safeActiveKeyIndex} onChange={(event) => setActiveKeyIndex(Number(event.target.value))} disabled={testingKey || busy}>
              {apiKeys.map((_, index) => (
                <option value={index} key={index}>مفتاح رقم {index + 1}</option>
              ))}
            </select>
          </label>
        )}
        <p className="hint">{apiKeys.length > 0 ? `يوجد ${apiKeys.length} مفتاح/مفاتيح محفوظة. الحالي: رقم ${safeActiveKeyIndex + 1}.` : "لا توجد مفاتيح محفوظة."} المفاتيح المحفوظة لا تُعرض كنص، وعند quota أو rate limit يتم الانتقال للمفتاح التالي تلقائيًا.</p>
        <p className="hint" aria-live="polite">{apiKeyTestStatus || "أي مفتاح جديد أو بديل سيتم اختباره مع Gemini قبل قبوله."}</p>
      </section>

      <section className="card" aria-labelledby="files-title">
        <h2 id="files-title">2. الملفات والإعدادات</h2>
        <label htmlFor="files">اختر PDF أو صورًا</label>
        <input
          id="files"
          type="file"
          accept="application/pdf,image/*"
          multiple
          disabled={busy || loadingFiles}
          onChange={(event) => void handleFilesSelected(event.target.files)}
        />

        <div className="settings-grid">
          <label>
            من صفحة
            <input type="number" min={1} max={Math.max(1, pages.length)} value={pageFrom} disabled={busy || pages.length === 0} onChange={(event) => setPageFrom(Number(event.target.value))} />
          </label>
          <label>
            إلى صفحة
            <input type="number" min={1} max={Math.max(1, pages.length)} value={pageTo} disabled={busy || pages.length === 0} onChange={(event) => setPageTo(Number(event.target.value))} />
          </label>
          <label>
            نوع الإخراج
            <select value={outputMode} onChange={(event) => setOutputMode(event.target.value as OutputMode)} disabled={busy}>
              <option value="word">Word DOCX</option>
              <option value="text">TXT</option>
            </select>
          </label>
          <label>
            وضع التحويل
            <select value={conversionMode} onChange={(event) => setConversionMode(event.target.value as ConversionMode)} disabled={busy}>
              <option value="fast">سريع</option>
              <option value="balanced">متوازن</option>
              <option value="advanced">متقدم</option>
            </select>
          </label>
        </div>

        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={includeImageDescriptions}
            onChange={(event) => setIncludeImageDescriptions(event.target.checked)}
            disabled={busy}
          />
          وصف الصور إن وجدت
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={includeEmbeddedImages}
            onChange={(event) => setIncludeEmbeddedImages(event.target.checked)}
            disabled={busy || outputMode === "text"}
          />
          إدراج صورة الصفحة الأصلية داخل Word
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={privacyAccepted}
            onChange={(event) => setPrivacyAccepted(event.target.checked)}
            disabled={busy}
          />
          أوافق على إرسال صورة الصفحة الحالية إلى Gemini عند التحويل
        </label>
        <p className="hint">عدد الصفحات الجاهزة: {pages.length}. النطاق الحالي: {selectedRangeStart} إلى {selectedRangeEnd}. يتم إرسال طلب Gemini واحد فقط في كل مرة.</p>
      </section>

      <section className="card" aria-labelledby="actions-title">
        <h2 id="actions-title">3. التحويل والتنزيل</h2>
        <div className="button-row">
          <button type="button" onClick={() => void startConversion(false)} disabled={busy || loadingFiles}>بدء التحويل</button>
          <button type="button" className="secondary" onClick={stopConversion} disabled={!busy}>إيقاف</button>
          <button type="button" className="secondary" onClick={() => void startConversion(true)} disabled={busy || !hasFailedPages}>إعادة محاولة الفاشل</button>
          <button type="button" onClick={() => void handleDownload()} disabled={!hasSuccessfulPages || busy}>تنزيل النتيجة</button>
          <button type="button" className="secondary" onClick={handleDownloadErrors} disabled={!hasFailedPages || busy}>تنزيل تقرير الأخطاء</button>
        </div>
      </section>

      <section className="card" aria-labelledby="preview-title">
        <h2 id="preview-title">معاينة النص والانتقال</h2>
        <div className="button-row search-row">
          <label htmlFor="search-box" className="search-label">بحث داخل النتائج</label>
          <input
            id="search-box"
            ref={searchRef}
            type="search"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="اكتب كلمة أو عبارة"
          />
          <button type="button" className="secondary" onClick={() => findInPreview("next")}>بحث التالي F3</button>
          <button type="button" className="secondary" onClick={() => findInPreview("previous")}>بحث السابق Shift+F3</button>
          <button type="button" className="secondary" onClick={() => goToPage(selectedRangeStart)}>انتقال لأول صفحة في النطاق Ctrl+G</button>
        </div>
        <textarea
          ref={previewRef}
          className="preview-box"
          value={previewText}
          readOnly
          rows={12}
          aria-label="معاينة النص المستخرج"
        />
        <p className="hint">الاختصارات: Ctrl+K للمفاتيح، Ctrl+F للبحث، F3 للتالي، Shift+F3 للسابق، Ctrl+G للانتقال إلى صفحة.</p>
      </section>

      <section className="card" aria-labelledby="results-title">
        <h2 id="results-title">نتائج الصفحات</h2>
        {results.length === 0 ? (
          <p>لم تبدأ المعالجة بعد.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <caption>حالة كل صفحة</caption>
              <thead>
                <tr>
                  <th scope="col">الصفحة</th>
                  <th scope="col">المصدر</th>
                  <th scope="col">الحالة</th>
                  <th scope="col">تفاصيل</th>
                </tr>
              </thead>
              <tbody>
                {results.map((result) => (
                  <tr key={result.page.id}>
                    <td>{result.page.pageNumber}</td>
                    <td>{result.page.sourceName}</td>
                    <td>{statusLabel(result.status)}</td>
                    <td>{result.error || result.data?.warnings?.join("؛ ") || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="ask-title">
        <h2 id="ask-title">اسأل عن الكتاب</h2>
        <label htmlFor="ask-question">اكتب سؤالك عن الصفحات المحولة</label>
        <textarea
          id="ask-question"
          ref={askRef}
          className="preview-box"
          rows={4}
          value={askQuestion}
          onChange={(event) => setAskQuestion(event.target.value)}
          placeholder="مثال نصي: ما الفكرة الرئيسية؟ مثال بصري: صف الصورة في الصفحة 5"
        />
        <div className="button-row">
          <button type="button" onClick={() => void handleAskBook()} disabled={askBusy || !hasSuccessfulPages}>اسأل Ctrl+Shift+Q</button>
        </div>
        <textarea className="preview-box" readOnly rows={8} value={askAnswer} aria-label="إجابة اسأل عن الكتاب" />
        {askHistory.length > 0 && (
          <details>
            <summary>سجل آخر الأسئلة</summary>
            {askHistory.map((item, index) => (
              <article className="history-item" key={`${item.question}-${index}`}>
                <strong>سؤال:</strong>
                <p>{item.question}</p>
                <strong>إجابة:</strong>
                <p>{item.answer}</p>
              </article>
            ))}
          </details>
        )}
      </section>
    </main>
  );
}

function buildPreviewText(results: PageResult[]): string {
  return results
    .filter((result) => result.status === "done" && result.data)
    .map((result) => {
      const data = result.data!;
      const lines = [`=== الصفحة ${result.page.pageNumber} ===`];
      lines.push(...data.text_blocks.map((block) => block.text || block.runs?.map((run) => run.text).join("") || ""));
      for (const table of data.tables ?? []) {
        lines.push(...table.rows.map((row) => row.join("\t")));
      }
      lines.push(...(data.image_descriptions ?? []));
      return lines.filter(Boolean).join("\n");
    })
    .join("\n\n");
}

function isVisualQuestion(question: string): boolean {
  return /صورة|صور|شكل|رسم|جدول مرئي|صفحة مرئية|مخطط|لون|ألوان|visual|image|picture|figure/i.test(question);
}

function parseMentionedPageRange(question: string): { from: number; to: number } | null {
  const rangeMatch = /(?:صفحة|الصفحة|page)\s*(\d+)\s*(?:إلى|الى|-|to)\s*(\d+)/i.exec(question);
  if (rangeMatch) {
    const from = Number(rangeMatch[1]);
    const to = Number(rangeMatch[2]);
    return { from: Math.min(from, to), to: Math.max(from, to) };
  }

  const singleMatch = /(?:صفحة|الصفحة|page)\s*(\d+)/i.exec(question);
  if (singleMatch) {
    const page = Number(singleMatch[1]);
    return { from: page, to: page };
  }

  return null;
}

function buildTextAskPrompt(question: string, context: string): string {
  return `أجب عن سؤال المستخدم اعتمادًا على مقتطفات الصفحات المحولة فقط.
إذا لم توجد الإجابة في النص، قل إن الإجابة غير واضحة من الصفحات المحولة.
اذكر أرقام الصفحات التي اعتمدت عليها كلما أمكن.

سؤال المستخدم:
${question}

مقتطفات الصفحات:
${context.slice(0, 120000)}`;
}

function buildVisualAskPrompt(question: string, pageNumbers: number[]): string {
  return `أجب عن السؤال اعتمادًا على صور الصفحات المرفقة فقط.
الصفحات المرفقة بالترتيب: ${pageNumbers.join(", ")}.
لا تخترع تفاصيل غير ظاهرة، واذكر رقم الصفحة عند الإجابة.

سؤال المستخدم:
${question}`;
}

function updateResult(results: PageResult[], index: number, patch: Partial<PageResult>): PageResult[] {
  return results.map((result, currentIndex) => currentIndex === index ? { ...result, ...patch } : result);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function clampPage(value: number, total: number): number {
  if (total <= 0) {
    return 1;
  }

  return Math.min(Math.max(1, Number.isFinite(value) ? value : 1), total);
}

function rotateKeys(keys: string[], startIndex: number): string[] {
  if (keys.length === 0) {
    return [];
  }

  const start = Math.min(Math.max(startIndex, 0), keys.length - 1);
  return [...keys.slice(start), ...keys.slice(0, start)];
}

function isQuotaOrKeyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return /quota|rate|limit|permission|api key|apikey|unauth|forbidden|exceeded|billing/.test(message);
}

function fallbackFromLocalText(page: SourcePage, error: unknown) {
  if (!page.localText?.trim()) {
    return null;
  }

  const reason = error instanceof Error ? error.message : "فشل Gemini.";
  return resultFromPlainText(page.localText, page.pageNumber, `تم استخدام نص PDF المحلي بعد فشل Gemini: ${reason}`);
}

function statusLabel(status: PageResult["status"]): string {
  if (status === "processing") return "قيد المعالجة";
  if (status === "done") return "ناجحة";
  if (status === "failed") return "فاشلة";
  if (status === "skipped") return "متروكة";
  return "بانتظار";
}
