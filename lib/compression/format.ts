import type {
  CompressedFileEntry,
  CompressionLevel,
  CompressionPresetConfig,
  FileCategory,
} from './types';

export const PRESET_CONFIGS: Record<CompressionLevel, CompressionPresetConfig> = {
  light: {
    level: 'light',
    label: 'Light',
    description: 'High quality, light compression',
    targetReductionPercent: 35,
    imageQuality: 0.85,
    maxDimension: 2400,
    zipLevel: 6,
  },
  balanced: {
    level: 'balanced',
    label: 'Balanced',
    description: 'Strong reduction, sharp quality',
    targetReductionPercent: 70,
    imageQuality: 0.65,
    maxDimension: 1600,
    zipLevel: 8,
  },
  maximum: {
    level: 'maximum',
    label: 'Maximum',
    description: 'Heaviest compression, smallest size',
    targetReductionPercent: 95,
    imageQuality: 0.36,
    maxDimension: 1024,
    zipLevel: 9,
  },
};

export function getPresetConfig(level: CompressionLevel): CompressionPresetConfig {
  return PRESET_CONFIGS[level];
}

export function getConfigFromStrength(
  strengthPercent: number
): CompressionPresetConfig {
  const clamped = Math.max(10, Math.min(95, Math.round(strengthPercent)));
  if (clamped === 35) return PRESET_CONFIGS.light;
  if (clamped === 70) return PRESET_CONFIGS.balanced;
  if (clamped === 95) return PRESET_CONFIGS.maximum;

  const t = (clamped - 10) / 85; // 0..1
  const imageQuality = Math.round((0.94 - t * 0.58) * 100) / 100;
  const maxDimension = Math.round(2800 - t * 1776);
  const zipLevel = Math.max(
    4,
    Math.min(9, Math.round(4 + t * 5))
  ) as CompressionPresetConfig['zipLevel'];

  const level: CompressionLevel =
    clamped < 50 ? 'light' : clamped < 82 ? 'balanced' : 'maximum';

  return {
    level,
    label: PRESET_CONFIGS[level].label,
    description: PRESET_CONFIGS[level].description,
    targetReductionPercent: clamped,
    imageQuality,
    maxDimension,
    zipLevel,
  };
}

export function getFileExtension(fileName: string): string {
  const clean = fileName.trim();
  const lastDot = clean.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === clean.length - 1) {
    return '';
  }
  return clean.slice(lastDot + 1).toLowerCase();
}

const OFFICE_DOC_EXTS = new Set(['docx', 'doc', 'odt', 'rtf']);
const OFFICE_PPT_EXTS = new Set(['pptx', 'ppt', 'odp']);
const OFFICE_SHEET_EXTS = new Set(['xlsx', 'xls', 'ods', 'csv']);
const IMAGE_EXTS = new Set([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'bmp',
  'avif',
  'gif',
  'tif',
  'tiff',
]);
const VIDEO_EXTS = new Set([
  'mp4',
  'mov',
  'mkv',
  'webm',
  'avi',
  'm4v',
  'wmv',
  'flv',
]);
const AUDIO_EXTS = new Set([
  'mp3',
  'wav',
  'm4a',
  'aac',
  'ogg',
  'flac',
  'wma',
  'opus',
]);
const TEXT_EXTS = new Set([
  'txt',
  'json',
  'xml',
  'svg',
  'html',
  'htm',
  'css',
  'js',
  'ts',
  'md',
  'yaml',
  'yml',
]);
const ARCHIVE_EXTS = new Set(['zip', 'gz', 'tar', '7z', 'rar', 'bz2']);

export function detectFileCategory(
  fileName: string,
  mimeType = ''
): FileCategory {
  const ext = getFileExtension(fileName);
  const mime = mimeType.toLowerCase();

  if (OFFICE_DOC_EXTS.has(ext) || mime.includes('wordprocessingml')) {
    return 'document';
  }
  if (OFFICE_PPT_EXTS.has(ext) || mime.includes('presentationml')) {
    return 'presentation';
  }
  if (OFFICE_SHEET_EXTS.has(ext) || mime.includes('spreadsheetml')) {
    return 'spreadsheet';
  }
  if (ext === 'pdf' || mime === 'application/pdf') {
    return 'pdf';
  }
  if (VIDEO_EXTS.has(ext) || mime.startsWith('video/')) {
    return 'video';
  }
  if (AUDIO_EXTS.has(ext) || mime.startsWith('audio/')) {
    return 'audio';
  }
  if (IMAGE_EXTS.has(ext) || (mime.startsWith('image/') && ext !== 'svg')) {
    return 'image';
  }
  if (TEXT_EXTS.has(ext) || mime.startsWith('text/')) {
    return 'text';
  }
  if (ARCHIVE_EXTS.has(ext)) {
    return 'archive';
  }
  return 'other';
}

export function getCategoryLabel(
  category: FileCategory,
  extension: string
): string {
  if (extension) {
    return extension.toUpperCase();
  }
  switch (category) {
    case 'document':
      return 'Document';
    case 'presentation':
      return 'Presentation';
    case 'spreadsheet':
      return 'Spreadsheet';
    case 'image':
      return 'Image';
    case 'video':
      return 'Video';
    case 'audio':
      return 'Audio';
    case 'pdf':
      return 'PDF';
    case 'text':
      return 'Text';
    case 'archive':
      return 'Archive';
    default:
      return 'File';
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  if (unitIndex === 0) {
    return `${Math.round(value)} B`;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

export function calculateSavings(
  originalSize: number,
  compressedSize: number
): { savedBytes: number; savedPercent: number } {
  if (originalSize <= 0 || compressedSize < 0) {
    return { savedBytes: 0, savedPercent: 0 };
  }
  const diff = Math.max(0, originalSize - compressedSize);
  const percent = (diff / originalSize) * 100;
  return {
    savedBytes: diff,
    savedPercent: Math.round(percent * 10) / 10,
  };
}

export function buildOutputFileName(
  originalName: string,
  targetExtension: string
): string {
  const clean = originalName.trim() || 'file';
  const ext = getFileExtension(clean);
  const baseName = ext ? clean.slice(0, -(ext.length + 1)) : clean;
  const cleanTarget = targetExtension.replace(/^\./, '').toLowerCase();
  if (!cleanTarget) {
    return `${baseName}-compressed`;
  }
  return `${baseName}-compressed.${cleanTarget}`;
}

export function minifyXmlContent(xml: string): string {
  return xml
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/>\s+</g, '><')
    .trim();
}

export function minifyTextContent(content: string, extension: string): string {
  const ext = extension.toLowerCase();
  if (ext === 'json') {
    try {
      return JSON.stringify(JSON.parse(content));
    } catch {
      return content.trim();
    }
  }
  if (ext === 'svg' || ext === 'xml' || ext === 'html' || ext === 'htm') {
    return content
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/>\s+</g, '><')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }
  if (ext === 'css') {
    return content
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\s*([{}:;,])\s*/g, '$1')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }
  return content
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface BatchSummary {
  totalFiles: number;
  completedFiles: number;
  processingFiles: number;
  errorFiles: number;
  totalOriginal: number;
  totalCompressed: number;
  totalSavedBytes: number;
  totalSavedPercent: number;
}

export function summarizeBatch(
  entries: Array<
    Pick<CompressedFileEntry, 'originalSize' | 'compressedSize' | 'status'>
  >
): BatchSummary {
  let completedFiles = 0;
  let processingFiles = 0;
  let errorFiles = 0;
  let totalOriginal = 0;
  let totalCompressed = 0;

  for (const entry of entries) {
    if (entry.status === 'done' && entry.compressedSize !== null) {
      completedFiles += 1;
      totalOriginal += entry.originalSize;
      totalCompressed += entry.compressedSize;
    } else if (entry.status === 'compressing' || entry.status === 'pending') {
      processingFiles += 1;
    } else if (entry.status === 'error') {
      errorFiles += 1;
    }
  }

  const { savedBytes, savedPercent } = calculateSavings(
    totalOriginal,
    totalCompressed
  );

  return {
    totalFiles: entries.length,
    completedFiles,
    processingFiles,
    errorFiles,
    totalOriginal,
    totalCompressed,
    totalSavedBytes: savedBytes,
    totalSavedPercent: savedPercent,
  };
}
