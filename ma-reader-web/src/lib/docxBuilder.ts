import {
  AlignmentType,
  BorderStyle,
  Document,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType
} from "docx";
import type { PageResult, WordRun } from "./types";

export async function buildDocx(results: PageResult[]): Promise<Blob> {
  const children = results
    .filter((result) => result.status === "done" && result.data)
    .flatMap((result) => pageToDocxChildren(result));

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

function pageToDocxChildren(result: PageResult): Array<Paragraph | Table> {
  const data = result.data!;
  const children: Array<Paragraph | Table> = [
    paragraph(`الصفحة ${result.page.pageNumber}`, { bold: true })
  ];

  for (const block of data.text_blocks) {
    children.push(runsParagraph(block.runs?.length ? block.runs : [{ text: block.text }]));
  }

  for (const table of data.tables ?? []) {
    children.push(buildTable(table.rows));
  }

  for (const description of data.image_descriptions ?? []) {
    children.push(paragraph(description));
  }

  children.push(paragraph(""));
  return children;
}

function paragraph(text: string, options?: { bold?: boolean }): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.RIGHT,
    bidirectional: true,
    children: [new TextRun({ text, bold: options?.bold, rightToLeft: true })]
  });
}

function runsParagraph(runs: WordRun[]): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.RIGHT,
    bidirectional: true,
    children: runs.map((run) => new TextRun({
      text: run.text,
      bold: run.bold,
      italics: run.italic,
      underline: run.underline ? {} : undefined,
      rightToLeft: true
    }))
  });
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
