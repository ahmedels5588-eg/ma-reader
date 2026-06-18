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
  localText?: string;
}

export interface WordRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  font_size?: number;
}

export interface TextBlock {
  text: string;
  runs?: WordRun[];
  role?: "heading" | "paragraph" | "list_item";
  level?: number;
  alignment?: "right" | "center" | "left";
  font_size?: number;
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
  includeEmbeddedImages: boolean;
}

export interface AppSettings extends ConvertOptions {
  pageFrom: number;
  pageTo: number;
  privacyAccepted: boolean;
}
