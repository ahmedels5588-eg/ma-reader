import { useEffect, useRef, useState } from "react";
import { summarizeProgress } from "./lib/accessibility";
import { buildDocx, buildPlainText, downloadBlob } from "./lib/docxBuilder";
import { convertPageWithGemini } from "./lib/gemini";
import { filesToSourcePages } from "./lib/pdf";
import { deleteApiKey, loadApiKey, saveApiKey } from "./lib/storage";
import type { ConversionMode, ConvertOptions, OutputMode, PageResult, SourcePage } from "./lib/types";

const REQUEST_DELAY_MS = 1200;

export default function App() {
  const [apiKey, setApiKey] = useState("");
  const [apiKeySaved, setApiKeySaved] = useState(false);
  const [pages, setPages] = useState<SourcePage[]>([]);
  const [results, setResults] = useState<PageResult[]>([]);
  const [outputMode, setOutputMode] = useState<OutputMode>("word");
  const [conversionMode, setConversionMode] = useState<ConversionMode>("balanced");
  const [includeImageDescriptions, setIncludeImageDescriptions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("جاهز.");
  const [assertiveMessage, setAssertiveMessage] = useState("");
  const [loadingFiles, setLoadingFiles] = useState(false);
  const stopRequested = useRef(false);
  const abortController = useRef<AbortController | null>(null);

  useEffect(() => {
    const storedApiKey = loadApiKey();
    setApiKey(storedApiKey);
    setApiKeySaved(storedApiKey.length > 0);
  }, []);

  const doneCount = results.filter((result) => result.status === "done").length;
  const failedCount = results.filter((result) => result.status === "failed").length;
  const progressText = summarizeProgress(doneCount, failedCount, results.length || pages.length);
  const hasSuccessfulPages = results.some((result) => result.status === "done");
  const hasFailedPages = results.some((result) => result.status === "failed");

  function handleSaveApiKey() {
    if (!apiKey.trim()) {
      setAssertiveMessage("أدخل مفتاح Gemini API أولًا.");
      return;
    }

    saveApiKey(apiKey);
    setApiKeySaved(true);
    setMessage("تم حفظ مفتاح API محليًا في هذا المتصفح فقط.");
  }

  function handleDeleteApiKey() {
    deleteApiKey();
    setApiKey("");
    setApiKeySaved(false);
    setMessage("تم حذف مفتاح API من هذا المتصفح.");
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
      setMessage(`تم تجهيز ${extractedPages.length} صفحة. لم يتم رفع ملف PDF كامل إلى الخادم.`);
    } catch (error) {
      setAssertiveMessage(error instanceof Error ? error.message : "فشل تجهيز الملفات.");
    } finally {
      setLoadingFiles(false);
    }
  }

  async function startConversion(onlyFailed: boolean) {
    if (!apiKey.trim()) {
      setAssertiveMessage("أدخل مفتاح Gemini API قبل بدء التحويل.");
      return;
    }

    if (pages.length === 0) {
      setAssertiveMessage("اختر PDF أو صورًا أولًا.");
      return;
    }

    const initialResults = results.length === pages.length
      ? results
      : pages.map((page) => ({ page, status: "pending" as const }));
    const targetIndexes = initialResults
      .map((result, index) => ({ result, index }))
      .filter(({ result }) => onlyFailed ? result.status === "failed" : result.status !== "done")
      .map(({ index }) => index);

    if (targetIndexes.length === 0) {
      setMessage("لا توجد صفحات تحتاج إلى تحويل.");
      return;
    }

    setResults(initialResults);
    setBusy(true);
    stopRequested.current = false;
    setAssertiveMessage(onlyFailed ? "بدأت إعادة محاولة الصفحات الفاشلة." : "بدأ التحويل.");

    const options: ConvertOptions = { outputMode, conversionMode, includeImageDescriptions };
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
        setMessage(`جاري تحويل الصفحة ${pages[index].pageNumber} من ${pages.length}...`);

        try {
          const data = await convertPageWithGemini(apiKey.trim(), pages[index], options, abortController.current.signal);
          workingResults = updateResult(workingResults, index, { status: "done", data, error: undefined });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "فشل غير معروف.";
          workingResults = updateResult(workingResults, index, { status: "failed", error: errorMessage });
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

    const blob = await buildDocx(results);
    downloadBlob(blob, "ma-reader-output.docx");
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
        <h2 id="api-title">1. مفتاح Gemini API</h2>
        <label htmlFor="api-key">المفتاح</label>
        <input
          id="api-key"
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder="AIza..."
        />
        <div className="button-row">
          <button type="button" onClick={handleSaveApiKey}>حفظ محليًا</button>
          <button type="button" className="secondary" onClick={handleDeleteApiKey}>حذف المفتاح</button>
        </div>
        <p className="hint">الحالة: {apiKeySaved ? "يوجد مفتاح محفوظ محليًا" : "لا يوجد مفتاح محفوظ"}. لا نطبع المفتاح في السجلات ولا نرسله إلا عند التحويل.</p>
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
        <p className="hint">عدد الصفحات الجاهزة: {pages.length}. يتم إرسال طلب Gemini واحد فقط في كل مرة.</p>
      </section>

      <section className="card" aria-labelledby="actions-title">
        <h2 id="actions-title">3. التحويل والتنزيل</h2>
        <div className="button-row">
          <button type="button" onClick={() => void startConversion(false)} disabled={busy || loadingFiles}>بدء التحويل</button>
          <button type="button" className="secondary" onClick={stopConversion} disabled={!busy}>إيقاف</button>
          <button type="button" className="secondary" onClick={() => void startConversion(true)} disabled={busy || !hasFailedPages}>إعادة محاولة الفاشل</button>
          <button type="button" onClick={() => void handleDownload()} disabled={!hasSuccessfulPages || busy}>تنزيل النتيجة</button>
        </div>
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
    </main>
  );
}

function updateResult(results: PageResult[], index: number, patch: Partial<PageResult>): PageResult[] {
  return results.map((result, currentIndex) => currentIndex === index ? { ...result, ...patch } : result);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function statusLabel(status: PageResult["status"]): string {
  if (status === "processing") return "قيد المعالجة";
  if (status === "done") return "ناجحة";
  if (status === "failed") return "فاشلة";
  if (status === "skipped") return "متروكة";
  return "بانتظار";
}
