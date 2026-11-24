export type CompressionLevel = 'light' | 'balanced' | 'maximum';

export type OutputMode = 'smart' | 'zip';

export type FileCategory =
  | 'document'
  | 'presentation'
  | 'spreadsheet'
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'text'
  | 'archive'
  | 'other';

export interface CompressionPresetConfig {
  level: CompressionLevel;
  label: string;
  description: string;
  targetReductionPercent: number;
  imageQuality: number;
  maxDimension: number;
  zipLevel: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
}

export type CompressionStatus = 'pending' | 'compressing' | 'done' | 'error';

export interface CompressedFileEntry {
  id: string;
  file: File;
  originalName: string;
  outputName: string;
  extension: string;
  outputExtension: string;
  category: FileCategory;
  originalSize: number;
  compressedSize: number | null;
  status: CompressionStatus;
  errorMessage?: string;
  note?: string;
  blob?: Blob;
  objectUrl?: string;
}
