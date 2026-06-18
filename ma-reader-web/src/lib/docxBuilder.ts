import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType
} from "docx";
import type { PageResult, WordRun } from "./types";

export async function buildDocx(results: PageResult[], includePageImages = false): Promise<Blob> {
  const children = results
    .filter((result) => result.status === "done" && result.data)
    .flatMap((result) => pageToDocxChildren(result, includePageImages));

  const doc = new Document({
    sections: [
      {
        properties: {},
        children: children.length > 0 ? children : [paragraph("لا توجد صفحات ناجحة.")]
      }
    ]
  });

  return Packer.toBlob(doc);
}

export function buildPlainText(results: PageResult[]): Blob {
  const content = results
    .filter((result) => result.status === "done" && result.data)
    .map((result) => {
      const data = result.data!;
      const parts = [`الصفحة ${result.page.pageNumber}`];
      parts.push(...data.text_blocks.map((block) => block.text || block.runs?.map((run) => run.text).join("") || ""));

      for (const table of data.tables ?? []) {
        for (const row of table.rows) {
          parts.push(row.join("\t"));
        }
      }

      for (const description of data.image_descriptions ?? []) {
        parts.push(description);
      }

      return parts.filter(Boolean).join("\n");
    })
    .join("\n\n");

  return new Blob([content || "لا توجد صفحات ناجحة."], { type: "text/plain;charset=utf-8" });
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = window.document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export function buildErrorReport(results: PageResult[]): Blob {
  const failed = results.filter((result) => result.status === "failed" || result.error);
  const lines = [
    "تقرير أخطاء MA Reader Web",
    `تاريخ التقرير: ${new Date().toLocaleString("ar")}`,
    `عدد الصفحات الفاشلة: ${failed.length}`,
    ""
  ];

  for (const result of failed) {
    lines.push(`الصفحة: ${result.page.pageNumber}`);
    lines.push(`المصدر: ${result.page.sourceName}`);
    lines.push(`الحالة: ${result.status}`);
    lines.push(`الخطأ: ${result.error || "-"}`);
    lines.push("---");
  }

  return new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
}

function pageToDocxChildren(result: PageResult, includePageImages: boolean): Array<Paragraph | Table> {
  const data = result.data!;
  const children: Array<Paragraph | Table> = [
    paragraph(`الصفحة ${result.page.pageNumber}`, { bold: true })
  ];

  for (const block of data.text_blocks) {
    children.push(runsParagraph(block.runs?.length ? block.runs : [{ text: block.text, font_size: block.font_size }], {
      role: block.role,
      level: block.level,
      alignment: block.alignment,
      fontSize: block.font_size
    }));
  }

  for (const table of data.tables ?? []) {
    children.push(buildTable(table.rows));
  }

  if (includePageImages) {
    const image = dataUrlToUint8Array(result.page.imageDataUrl);
    if (image) {
      const maxWidth = 520;
      const ratio = result.page.height / Math.max(result.page.width, 1);
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new ImageRun({
          type: "jpg",
          data: image,
          transformation: {
            width: maxWidth,
            height: Math.max(1, Math.round(maxWidth * ratio))
          }
        })]
      }));
    }
  }

  for (const description of data.image_descriptions ?? []) {
    children.push(paragraph(description));
  }

  children.push(paragraph(""));
  return children;
}

function dataUrlToUint8Array(dataUrl: string): Uint8Array | null {
  const base64 = dataUrl.split(",")[1];
  if (!base64) {
    return null;
  }

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function paragraph(text: string, options?: { bold?: boolean }): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.RIGHT,
    bidirectional: true,
    children: [new TextRun({ text, bold: options?.bold, rightToLeft: true })]
  });
}

function runsParagraph(
  runs: WordRun[],
  options?: { role?: string; level?: number; alignment?: "right" | "center" | "left"; fontSize?: number }
): Paragraph {
  return new Paragraph({
    alignment: docxAlignment(options?.alignment),
    bidirectional: true,
    heading: options?.role === "heading" ? HeadingLevel.HEADING_2 : undefined,
    bullet: options?.role === "list_item" ? { level: Math.min(Math.max(options.level ?? 0, 0), 3) } : undefined,
    children: runs.map((run) => new TextRun({
      text: run.text,
      bold: run.bold,
      italics: run.italic,
      underline: run.underline ? {} : undefined,
      size: (run.font_size ?? options?.fontSize) ? (run.font_size ?? options?.fontSize)! * 2 : undefined,
      font: "Arial",
      rightToLeft: true
    }))
  });
}

function docxAlignment(value?: "right" | "center" | "left") {
  if (value === "center") return AlignmentType.CENTER;
  if (value === "left") return AlignmentType.LEFT;
  return AlignmentType.RIGHT;
}

function buildTable(rows: string[][]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map((row) => new TableRow({
      children: row.map((cell) => new TableCell({
        borders: {
          top: { style: BorderStyle.SINGLE, size: 1, color: "999999" },
          bottom: { style: BorderStyle.SINGLE, size: 1, color: "999999" },
          left: { style: BorderStyle.SINGLE, size: 1, color: "999999" },
          right: { style: BorderStyle.SINGLE, size: 1, color: "999999" }
        },
        children: [paragraph(cell)]
      }))
    }))
  });
}
