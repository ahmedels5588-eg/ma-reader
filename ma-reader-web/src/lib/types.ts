export type OutputMode = "word" | "text";

export type ConversionMode = "fast" | "balanced" | "advanced";

export type PageStatus = "pending" | "processing" | "done" | "failed" | "skipped";

export interface SourcePage {
  id: string;
  sourceName: string;
  pageNumber: number;
  imageDataUrl: string;
  width: number;
  height: number;
}

export interface WordRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export interface TextBlock {
  text: string;
  runs?: WordRun[];
}

export interface TableBlock {
  rows: string[][];
}

export interface GeminiPageResult {
  page_number: number;
  text_blocks: TextBlock[];
  tables?: TableBlock[];
  image_descriptions?: string[];
  warnings?: string[];
}

export interface PageResult {
  page: SourcePage;
  status: PageStatus;
  data?: GeminiPageResult;
  error?: string;
}

export interface ConvertOptions {
  outputMode: OutputMode;
  conversionMode: ConversionMode;
  includeImageDescriptions: boolean;
}
