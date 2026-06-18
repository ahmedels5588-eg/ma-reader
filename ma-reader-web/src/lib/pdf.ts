import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import type { SourcePage } from "./types";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const MAX_PAGE_SIDE = 1800;
const JPEG_QUALITY = 0.86;

export async function filesToSourcePages(files: File[]): Promise<SourcePage[]> {
  const pages: SourcePage[] = [];

  for (const file of files) {
    if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
      pages.push(...(await pdfToPages(file)));
      continue;
    }

    if (file.type.startsWith("image/")) {
      pages.push(await imageFileToPage(file, pages.length + 1));
    }
  }

  return pages.map((page, index) => ({ ...page, pageNumber: index + 1 }));
}

async function pdfToPages(file: File): Promise<SourcePage[]> {
  const data = new Uint8Array(await file.arrayBuffer());
  const pdfDocument = await pdfjsLib.getDocument({ data }).promise;
  const pages: SourcePage[] = [];

  for (let pageIndex = 1; pageIndex <= pdfDocument.numPages; pageIndex += 1) {
    const page = await pdfDocument.getPage(pageIndex);
    const viewportAtOne = page.getViewport({ scale: 1 });
    const scale = Math.min(MAX_PAGE_SIDE / Math.max(viewportAtOne.width, viewportAtOne.height), 2.2);
    const viewport = page.getViewport({ scale });
    const canvas = window.document.createElement("canvas");

    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("تعذر تجهيز محرك رسم الصفحة.");
    }

    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: context, viewport }).promise;

    pages.push({
      id: `${file.name}-${pageIndex}-${Date.now()}`,
      sourceName: file.name,
      pageNumber: pageIndex,
      imageDataUrl: canvas.toDataURL("image/jpeg", JPEG_QUALITY),
      width: canvas.width,
      height: canvas.height
    });
  }

  await pdfDocument.destroy();
  return pages;
}

async function imageFileToPage(file: File, pageNumber: number): Promise<SourcePage> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(MAX_PAGE_SIDE / Math.max(bitmap.width, bitmap.height), 1);
  const canvas = window.document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("تعذر تجهيز الصورة.");
  }

  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  return {
    id: `${file.name}-${pageNumber}-${Date.now()}`,
    sourceName: file.name,
    pageNumber,
    imageDataUrl: canvas.toDataURL("image/jpeg", JPEG_QUALITY),
    width: canvas.width,
    height: canvas.height
  };
}
