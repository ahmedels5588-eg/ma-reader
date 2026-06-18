import { useEffect, useRef, useState } from "react";
import { summarizeProgress } from "./lib/accessibility";
import { splitTextForTts, synthesizeSpeech, testGeminiTts, testGoogleCloudTts, ttsSegmentsToWavBlob, type TtsAudioSegment, type TtsProvider } from "./lib/audiobook";
import { buildDocx, buildErrorReport, buildPlainText, downloadBlob } from "./lib/docxBuilder";
import { askGemini, convertPageWithGemini, convertPagesWithGemini, rescuePageTextWithGemini, resultFromPlainText } from "./lib/gemini";
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
  const [pagesPerRequest, setPagesPerRequest] = useState(1);
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("جاهز.");
  const [assertiveMessage, setAssertiveMessage] = useState("");
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [cameraError, setCameraError] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [lastSearchIndex, setLastSearchIndex] = useState(-1);
  const [previewPageNumber, setPreviewPageNumber] = useState(1);
  const [askQuestion, setAskQuestion] = useState("");
  const [askAnswer, setAskAnswer] = useState("");
  const [askHistory, setAskHistory] = useState<Array<{ question: string; answer: string }>>([]);
  const [askBusy, setAskBusy] = useState(false);
  const [audiobookBusy, setAudiobookBusy] = useState(false);
  const [audiobookMessage, setAudiobookMessage] = useState("لم يتم إنشاء كتاب صوتي بعد.");
  const [audiobookBlob, setAudiobookBlob] = useState<Blob | null>(null);
  const [audiobookProgress, setAudiobookProgress] = useState(0);
  const [ttsProvider, setTtsProvider] = useState<TtsProvider>("gemini");
  const stopRequested = useRef(false);
  const abortController = useRef<AbortController | null>(null);
  const audiobookAbortController = useRef<AbortController | null>(null);
  const apiKeysRef = useRef<HTMLInputElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const askRef = useRef<HTMLTextAreaElement | null>(null);
  const previewRef = useRef<HTMLTextAreaElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

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
    setPagesPerRequest(clampPagesPerRequest(Number(settings.pagesPerRequest ?? 1)));
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
      pagesPerRequest,
      privacyAccepted
    };
    saveSettings(settings);
  }, [outputMode, conversionMode, includeImageDescriptions, includeEmbeddedImages, pageFrom, pageTo, pagesPerRequest, privacyAccepted]);

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

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = cameraStream;
      if (cameraStream) {
        void videoRef.current.play().catch(() => setCameraError("تعذر تشغيل معاينة الكاميرا."));
      }
    }
  }, [cameraStream]);

  useEffect(() => () => stopCameraStream(cameraStream), [cameraStream]);

  useEffect(() => {
    const firstDonePage = results.find((result) => result.status === "done")?.page.pageNumber;
    if (firstDonePage && !results.some((result) => result.status === "done" && result.page.pageNumber === previewPageNumber)) {
      setPreviewPageNumber(firstDonePage);
    }
  }, [results, previewPageNumber]);

  useEffect(() => {
    setLastSearchIndex(-1);
  }, [previewPageNumber, searchTerm]);

  const doneCount = results.filter((result) => result.status === "done").length;
  const failedCount = results.filter((result) => result.status === "failed").length;
  const progressText = summarizeProgress(doneCount, failedCount, results.length || pages.length);
  const hasSuccessfulPages = results.some((result) => result.status === "done");
  const hasFailedPages = results.some((result) => result.status === "failed");
  const safePageFrom = clampPage(pageFrom, pages.length);
  const safePageTo = clampPage(pageTo, pages.length);
  const selectedRangeStart = Math.min(safePageFrom, safePageTo);
  const selectedRangeEnd = Math.max(safePageFrom, safePageTo);
  const fullPreviewText = buildPreviewText(results);
  const successfulPreviewResults = results.filter((result) => result.status === "done" && result.data);
  const currentPreviewResult = successfulPreviewResults.find((result) => result.page.pageNumber === previewPageNumber) ?? successfulPreviewResults[0];
  const currentPreviewText = currentPreviewResult ? buildSinglePreviewText(currentPreviewResult) : "";
  const audiobookText = buildAudiobookText(results);
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
      const testResult = await testApiKey(key);
      persistApiKeys([...apiKeys, key], apiKeys.length);
      setMessage(`${testResult.message} عدد المفاتيح المحفوظة الآن: ${apiKeys.length + 1}.`);
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
      const testResult = await testApiKey(key);
      const nextKeys = [...apiKeys];
      nextKeys[safeActiveKeyIndex] = key;
      persistApiKeys(nextKeys, safeActiveKeyIndex);
      setMessage(`${testResult.message} تم استبدال المفتاح رقم ${safeActiveKeyIndex + 1}.`);
    } catch (error) {
      rejectApiKey(error);
    }
  }

  async function testApiKey(key: string): Promise<{ accepted: true; message: string }> {
    setTestingKey(true);
    setApiKeyTestStatus("جاري اختبار المفتاح مع Gemini...");
    try {
      try {
        await askGemini(key, "اختبار مفتاح API. أجب بكلمة OK فقط.");
      } catch (error) {
        if (!isGoogleRestrictionPreviewWarning(error)) {
          throw error;
        }
      }

      setApiKeyTestStatus("نجح اختبار Gemini. جاري اختبار Gemini TTS...");
      await testGeminiTts(key);
      const message = "تم اختبار المفتاح بنجاح مع Gemini وGemini TTS وتم قبوله.";
      setApiKeyTestStatus(message);
      return { accepted: true, message };
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

  async function handleTestGoogleCloudTts() {
    const key = apiKeyInput.trim() || apiKeys[safeActiveKeyIndex];
    if (!key) {
      setAssertiveMessage("أدخل مفتاحًا أو احفظ مفتاحًا أولًا لاختبار Google Cloud TTS.");
      return;
    }

    setTestingKey(true);
    setApiKeyTestStatus("جاري اختبار Google Cloud TTS...");
    try {
      await testGoogleCloudTts(key);
      setApiKeyTestStatus("نجح اختبار Google Cloud TTS لهذا المفتاح.");
      setMessage("Google Cloud TTS متاح لهذا المفتاح.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "فشل اختبار Google Cloud TTS.";
      setApiKeyTestStatus(`فشل اختبار Google Cloud TTS: ${message}`);
      setAssertiveMessage("فشل اختبار Google Cloud TTS. هذا لا يعني أن مفتاح Gemini غير صالح.");
    } finally {
      setTestingKey(false);
    }
  }

  async function handleFilesSelected(fileList: FileList | null) {
    if (!fileList?.length) {
      return;
    }

    setLoadingFiles(true);
    setMessage("جاري تجهيز الصفحات داخل المتصفح...");

    try {
      const extractedPages = await filesToSourcePages(Array.from(fileList));
      appendSourcePages(extractedPages);
      setMessage(`تمت إضافة ${extractedPages.length} صفحة. لم يتم رفع ملف PDF كامل إلى الخادم.`);
    } catch (error) {
      setAssertiveMessage(error instanceof Error ? error.message : "فشل تجهيز الملفات.");
    } finally {
      setLoadingFiles(false);
    }
  }

  function appendSourcePages(newPages: SourcePage[]) {
    if (newPages.length === 0) {
      return;
    }

    const combinedPages = [...pages, ...newPages].map((page, index) => ({ ...page, pageNumber: index + 1 }));
    const previousResults = new Map(results.map((result) => [result.page.id, result]));
    setPages(combinedPages);
    setResults(combinedPages.map((page) => {
      const previous = previousResults.get(page.id);
      return previous ? { ...previous, page } : { page, status: "pending" };
    }));
    if (pages.length === 0) {
      setPageFrom(1);
    }
    setPageTo(Math.max(1, combinedPages.length));
  }

  function deleteSourcePage(pageId: string) {
    if (busy || loadingFiles) {
      setAssertiveMessage("لا يمكن حذف صفحة أثناء التجهيز أو التحويل.");
      return;
    }

    const pageToDelete = pages.find((page) => page.id === pageId);
    if (!pageToDelete?.id.startsWith("camera-")) {
      setAssertiveMessage("يمكن حذف الصور الملتقطة بالكاميرا فقط.");
      return;
    }

    const keptPages = pages.filter((page) => page.id !== pageId).map((page, index) => ({ ...page, pageNumber: index + 1 }));
    const keptIds = new Set(keptPages.map((page) => page.id));
    const renumberedResults = results
      .filter((result) => keptIds.has(result.page.id))
      .map((result) => {
        const page = keptPages.find((candidate) => candidate.id === result.page.id)!;
        return { ...result, page };
      });

    setPages(keptPages);
    setResults(renumberedResults);
    setPageFrom(keptPages.length > 0 ? Math.min(pageFrom, keptPages.length) : 1);
    setPageTo(keptPages.length > 0 ? Math.min(pageTo, keptPages.length) : 1);

    const nextPreviewPage = renumberedResults.find((result) => result.status === "done")?.page.pageNumber ?? 1;
    setPreviewPageNumber(nextPreviewPage);
    setMessage(keptPages.length > 0 ? "تم حذف الصفحة وإعادة ترقيم الصفحات." : "تم حذف كل الصفحات المختارة.");
  }

  async function openCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError("الكاميرا غير مدعومة في هذا المتصفح.");
      return;
    }

    try {
      setCameraError("");
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false
      });
      stopCameraStream(cameraStream);
      setCameraStream(stream);
      setMessage("تم فتح الكاميرا. وجّه الصفحة ثم اضغط التقاط صورة.");
    } catch (error) {
      setCameraError(error instanceof Error ? error.message : "تعذر فتح الكاميرا.");
    }
  }

  function closeCamera() {
    stopCameraStream(cameraStream);
    setCameraStream(null);
    setCameraError("");
    setMessage("تم إغلاق الكاميرا.");
  }

  function captureCameraPage() {
    const video = videoRef.current;
    if (!video || !cameraStream) {
      setCameraError("افتح الكاميرا أولًا قبل التقاط صورة.");
      return;
    }

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) {
      setCameraError("انتظر حتى تظهر معاينة الكاميرا ثم حاول الالتقاط مرة أخرى.");
      return;
    }

    const canvas = window.document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      setCameraError("تعذر تجهيز صورة الكاميرا.");
      return;
    }

    context.drawImage(video, 0, 0, width, height);
    const pageNumber = pages.length + 1;
    appendSourcePages([{ id: `camera-${Date.now()}`, sourceName: "صورة من الكاميرا", pageNumber, imageDataUrl: canvas.toDataURL("image/jpeg", 0.92), width, height }]);
    setMessage(`تم التقاط صورة من الكاميرا وإضافتها كصفحة رقم ${pageNumber}. يمكنك إضافة ملفات معها.`);
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
      const batches = chunkIndexes(targetIndexes, clampPagesPerRequest(pagesPerRequest));
      for (const batchIndexes of batches) {
        if (stopRequested.current) {
          for (const index of batchIndexes) {
            workingResults = updateResult(workingResults, index, { status: "skipped", error: "تم الإيقاف قبل معالجة الصفحة." });
          }
          setResults(workingResults);
          continue;
        }

        abortController.current = new AbortController();
        for (const index of batchIndexes) {
          workingResults = updateResult(workingResults, index, { status: "processing", error: undefined });
        }
        setResults(workingResults);

        const batchPages = batchIndexes.map((index) => pages[index]);
        const label = batchPages.length === 1
          ? `الصفحة ${batchPages[0].pageNumber}`
          : `الصفحات ${batchPages[0].pageNumber} إلى ${batchPages[batchPages.length - 1].pageNumber}`;
        setMessage(`جاري تحويل ${label} من ${pages.length} باستخدام مفتاح ${activeKeyIndex + 1} من ${apiKeys.length}...`);

        try {
          const batchData = batchPages.length === 1
            ? [await convertWithResilience(batchPages[0], options, abortController.current.signal)]
            : await convertBatchWithResilience(batchPages, options, abortController.current.signal);
          for (let itemIndex = 0; itemIndex < batchIndexes.length; itemIndex += 1) {
            workingResults = updateResult(workingResults, batchIndexes[itemIndex], { status: "done", data: batchData[itemIndex], error: undefined });
          }
        } catch {
          for (const index of batchIndexes) {
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
          }
        }

        setResults(workingResults);

        if (!stopRequested.current && batchIndexes !== batches[batches.length - 1]) {
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

  async function convertBatchWithResilience(batchPages: SourcePage[], options: ConvertOptions, signal?: AbortSignal) {
    let lastError: unknown;
    const orderedKeys = rotateKeys(apiKeys, activeKeyIndex);

    for (const key of orderedKeys) {
      const realIndex = apiKeys.indexOf(key);
      setActiveKeyIndex(realIndex >= 0 ? realIndex : 0);

      for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_KEY; attempt += 1) {
        if (stopRequested.current) {
          throw new Error("تم إيقاف التحويل.");
        }

        try {
          return await convertPagesWithGemini(key, batchPages, options, signal);
        } catch (error) {
          lastError = error;
          if (isQuotaOrKeyError(error)) {
            break;
          }
          if (attempt < MAX_ATTEMPTS_PER_KEY) {
            await delay(1500 * attempt);
          }
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error("فشلت دفعة الصفحات بكل المفاتيح.");
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

  async function handleCreateAudiobook() {
    if (apiKeys.length === 0) {
      setAssertiveMessage("أدخل مفتاح Gemini API قبل إنشاء الكتاب الصوتي.");
      return;
    }

    if (!audiobookText.trim()) {
      setAssertiveMessage("لا توجد صفحات محولة لإنشاء كتاب صوتي.");
      return;
    }

    const chunks = splitTextForTts(audiobookText);
    if (chunks.length === 0) {
      setAssertiveMessage("النص المحول فارغ ولا يمكن تحويله إلى صوت.");
      return;
    }

    setAudiobookBusy(true);
    setAudiobookBlob(null);
    setAudiobookProgress(0);
    setAudiobookMessage(`بدأ إنشاء الكتاب الصوتي. عدد المقاطع: ${chunks.length}.`);
    audiobookAbortController.current = new AbortController();
    const segments: TtsAudioSegment[] = [];

    try {
      for (let index = 0; index < chunks.length; index += 1) {
        if (audiobookAbortController.current.signal.aborted) {
          throw new Error("تم إيقاف إنشاء الكتاب الصوتي.");
        }

        setAudiobookMessage(`جاري إنشاء المقطع الصوتي ${index + 1} من ${chunks.length}...`);
        segments.push(await synthesizeSpeechWithKeys(chunks[index], audiobookAbortController.current.signal));
        setAudiobookProgress(Math.round(((index + 1) / chunks.length) * 100));
        if (index < chunks.length - 1) {
          await delay(500);
        }
      }

      const blob = ttsSegmentsToWavBlob(segments);
      setAudiobookBlob(blob);
      setAudiobookMessage("تم إنشاء الكتاب الصوتي بنجاح. يمكنك تنزيل ملف WAV الآن.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "فشل إنشاء الكتاب الصوتي.";
      setAudiobookMessage(message);
      setAssertiveMessage(message);
    } finally {
      audiobookAbortController.current = null;
      setAudiobookBusy(false);
    }
  }

  async function synthesizeSpeechWithKeys(text: string, signal?: AbortSignal): Promise<TtsAudioSegment> {
    let lastError: unknown;
    const orderedKeys = rotateKeys(apiKeys, activeKeyIndex);

    for (const key of orderedKeys) {
      try {
        const realIndex = apiKeys.indexOf(key);
        setActiveKeyIndex(realIndex >= 0 ? realIndex : 0);
        return await synthesizeSpeech(key, text, ttsProvider, signal);
      } catch (error) {
        lastError = error;
        if (!isQuotaOrKeyError(error)) {
          throw error;
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error("فشل إنشاء الصوت بكل المفاتيح.");
  }

  function stopAudiobookCreation() {
    audiobookAbortController.current?.abort();
    setAudiobookMessage("تم طلب إيقاف إنشاء الكتاب الصوتي.");
  }

  function handleDownloadAudiobook() {
    if (!audiobookBlob) {
      setAssertiveMessage("لا يوجد كتاب صوتي جاهز للتنزيل.");
      return;
    }

    downloadBlob(audiobookBlob, "ma-reader-audiobook.wav");
  }

  function findInPreview(direction: "next" | "previous") {
    const term = searchTerm.trim();
    const preview = previewRef.current;
    if (!term || !currentPreviewText || !preview) {
      setAssertiveMessage("اكتب نصًا للبحث أولًا.");
      return;
    }

    const haystack = currentPreviewText.toLocaleLowerCase("ar");
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
    if (!preview || successfulPreviewResults.length === 0) {
      setAssertiveMessage("لا توجد نتائج للانتقال داخلها.");
      return;
    }

    const exists = successfulPreviewResults.some((result) => result.page.pageNumber === pageNumber);
    if (!exists) {
      setAssertiveMessage(`لم يتم العثور على الصفحة ${pageNumber} داخل النتائج الحالية.`);
      return;
    }

    setPreviewPageNumber(pageNumber);
    preview.focus();
    setMessage(`تم الانتقال إلى الصفحة ${pageNumber}.`);
  }

  function movePreviewPage(delta: number) {
    if (successfulPreviewResults.length === 0) {
      setAssertiveMessage("لا توجد صفحات محولة للمعاينة.");
      return;
    }

    const currentIndex = successfulPreviewResults.findIndex((result) => result.page.pageNumber === (currentPreviewResult?.page.pageNumber ?? previewPageNumber));
    const nextIndex = Math.min(Math.max(currentIndex + delta, 0), successfulPreviewResults.length - 1);
    const nextPage = successfulPreviewResults[nextIndex].page.pageNumber;
    setPreviewPageNumber(nextPage);
    setMessage(`تم الانتقال في المعاينة إلى الصفحة ${nextPage}.`);
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
        : buildTextAskPrompt(question, fullPreviewText);
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
        <button type="button" className="secondary" onClick={() => void handleTestGoogleCloudTts()} disabled={testingKey || busy}>اختبار Google Cloud TTS اختياريًا</button>
        <p className="hint">{apiKeys.length > 0 ? `يوجد ${apiKeys.length} مفتاح/مفاتيح محفوظة. الحالي: رقم ${safeActiveKeyIndex + 1}.` : "لا توجد مفاتيح محفوظة."} المفاتيح المحفوظة لا تُعرض كنص، وعند quota أو rate limit يتم الانتقال للمفتاح التالي تلقائيًا.</p>
        <p className="hint" aria-live="polite">{apiKeyTestStatus || "أي مفتاح جديد أو بديل سيتم اختباره مع Gemini وGemini TTS قبل قبوله. Google Cloud TTS اختياري ومتقدم."}</p>
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

        <div className="camera-panel" aria-labelledby="camera-title">
          <h3 id="camera-title">التقاط صورة بالكاميرا</h3>
          <div className="button-row">
            <button type="button" className="secondary" onClick={() => void openCamera()} disabled={busy || loadingFiles || Boolean(cameraStream)}>فتح الكاميرا</button>
            <button type="button" onClick={captureCameraPage} disabled={busy || !cameraStream}>التقاط صورة وإضافتها</button>
            <button type="button" className="secondary" onClick={closeCamera} disabled={!cameraStream}>إغلاق الكاميرا</button>
          </div>
          {cameraStream && (
            <video ref={videoRef} className="camera-preview" playsInline muted aria-label="معاينة الكاميرا قبل التقاط الصورة" />
          )}
          {cameraError && <p className="hint" role="alert">{cameraError}</p>}
          <p className="hint">يمكن التقاط صورة من الكاميرا وإضافة PDF أو صور معها في نفس التحويل.</p>
        </div>

        {pages.some((page) => page.id.startsWith("camera-")) && (
          <div className="captured-list" aria-labelledby="captured-pages-title">
            <h3 id="captured-pages-title">الصور الملتقطة بالكاميرا</h3>
            {pages.filter((page) => page.id.startsWith("camera-")).map((page) => (
              <div className="captured-item" key={page.id}>
                <span>صورة ملتقطة، الصفحة {page.pageNumber}</span>
                <button type="button" className="secondary small-button" onClick={() => deleteSourcePage(page.id)} disabled={busy || loadingFiles}>حذف الصورة</button>
              </div>
            ))}
          </div>
        )}

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
            عدد الصفحات في الطلب الواحد
            <input
              type="number"
              min={1}
              max={10}
              value={pagesPerRequest}
              disabled={busy}
              onChange={(event) => setPagesPerRequest(clampPagesPerRequest(Number(event.target.value)))}
            />
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
        <p className="hint">عدد الصفحات الجاهزة: {pages.length}. النطاق الحالي: {selectedRangeStart} إلى {selectedRangeEnd}. عدد الصفحات في الطلب الواحد: {clampPagesPerRequest(pagesPerRequest)}. لا يتم تشغيل أكثر من طلب Gemini واحد في نفس الوقت.</p>
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

      <section className="card" aria-labelledby="audiobook-title">
        <h2 id="audiobook-title">4. الكتاب الصوتي</h2>
        <p className="hint">ينشئ ملف WAV واحدًا من الصفحات المحولة. Gemini TTS هو الاختيار الافتراضي الأسهل، وGoogle Cloud TTS خيار متقدم يحتاج تفعيل Text-to-Speech API. لا يتم تخزين الصوت على الخادم.</p>
        <label>
          مزود الصوت
          <select value={ttsProvider} onChange={(event) => setTtsProvider(event.target.value as TtsProvider)} disabled={audiobookBusy}>
            <option value="gemini">Gemini TTS - افتراضي</option>
            <option value="google">Google Cloud TTS - متقدم</option>
          </select>
        </label>
        <div className="button-row">
          <button type="button" onClick={() => void handleCreateAudiobook()} disabled={!hasSuccessfulPages || audiobookBusy || apiKeys.length === 0}>إنشاء كتاب صوتي</button>
          <button type="button" className="secondary" onClick={stopAudiobookCreation} disabled={!audiobookBusy}>إيقاف إنشاء الصوت</button>
          <button type="button" onClick={handleDownloadAudiobook} disabled={!audiobookBlob || audiobookBusy}>تنزيل الكتاب الصوتي WAV</button>
        </div>
        <progress value={audiobookProgress} max={100} aria-label="تقدم إنشاء الكتاب الصوتي" />
        <p className="hint" aria-live="polite">{audiobookMessage}</p>
      </section>

      <section className="card" aria-labelledby="preview-title">
        <h2 id="preview-title">معاينة النص والانتقال</h2>
        <div className="button-row search-row">
          <label htmlFor="preview-page" className="search-label">صفحة المعاينة</label>
          <select
            id="preview-page"
            value={currentPreviewResult?.page.pageNumber ?? ""}
            onChange={(event) => setPreviewPageNumber(Number(event.target.value))}
            disabled={successfulPreviewResults.length === 0}
          >
            {successfulPreviewResults.length === 0 ? (
              <option value="">لا توجد صفحات محولة</option>
            ) : successfulPreviewResults.map((result) => (
              <option value={result.page.pageNumber} key={result.page.id}>الصفحة {result.page.pageNumber}</option>
            ))}
          </select>
          <button type="button" className="secondary" onClick={() => movePreviewPage(-1)} disabled={successfulPreviewResults.length === 0}>الصفحة السابقة</button>
          <button type="button" className="secondary" onClick={() => movePreviewPage(1)} disabled={successfulPreviewResults.length === 0}>الصفحة التالية</button>
          <button type="button" className="secondary" onClick={() => currentPreviewResult && deleteSourcePage(currentPreviewResult.page.id)} disabled={!currentPreviewResult?.page.id.startsWith("camera-") || busy}>حذف الصورة الملتقطة</button>
        </div>
        <div className="button-row search-row">
          <label htmlFor="search-box" className="search-label">بحث داخل الصفحة الحالية</label>
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
          value={currentPreviewText}
          readOnly
          rows={12}
          aria-label="معاينة نص الصفحة الحالية"
        />
        <p className="hint">المعاينة تعرض صفحة واحدة لتسهيل الحركة. الاختصارات: Ctrl+K للمفاتيح، Ctrl+F للبحث، F3 للتالي، Shift+F3 للسابق، Ctrl+G للانتقال إلى صفحة.</p>
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
      const pageText = pageResultToText(result);
      return [`الصفحة ${result.page.pageNumber}`, pageText].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

function buildSinglePreviewText(result: PageResult): string {
  if (!result.data) {
    return "";
  }

  return pageResultToText(result);
}

function buildAudiobookText(results: PageResult[]): string {
  return results
    .filter((result) => result.status === "done" && result.data)
    .map((result) => {
      const pageText = pageResultToText(result);
      return [`الصفحة ${result.page.pageNumber}.`, pageText].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

function pageResultToText(result: PageResult): string {
  if (!result.data) {
    return "";
  }

  const data = result.data;
  const lines = data.text_blocks.map((block) => block.text || block.runs?.map((run) => run.text).join("") || "");
  for (const table of data.tables ?? []) {
    lines.push(...table.rows.map((row) => row.join("\t")));
  }
  lines.push(...(data.image_descriptions ?? []));
  return lines.filter(Boolean).join("\n");
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

function clampPagesPerRequest(value: number): number {
  return Math.min(Math.max(1, Number.isFinite(value) ? Math.round(value) : 1), 10);
}

function chunkIndexes(indexes: number[], chunkSize: number): number[][] {
  const chunks: number[][] = [];
  const size = clampPagesPerRequest(chunkSize);
  for (let index = 0; index < indexes.length; index += size) {
    chunks.push(indexes.slice(index, index + size));
  }
  return chunks;
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

function isGoogleRestrictionPreviewWarning(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("temporary service disruptions") && message.includes("unrestricted keys");
}

function stopCameraStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
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
