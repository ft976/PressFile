'use client';

import {
  AlertCircle,
  ArrowRight,
  Download,
  File,
  FileArchive,
  FileSpreadsheet,
  FileText,
  Film,
  Image as ImageIcon,
  Loader2,
  Music,
  Presentation,
  X,
} from 'lucide-react';
import {
  calculateSavings,
  formatBytes,
  getCategoryLabel,
} from '@/lib/compression/format';
import type { CompressedFileEntry, FileCategory } from '@/lib/compression/types';

interface FileRowProps {
  entry: CompressedFileEntry;
  onDownload: (entry: CompressedFileEntry) => void;
  onRemove: (id: string) => void;
}

function renderCategoryIcon(category: FileCategory) {
  const iconClass = 'h-5 w-5 text-slate-500 shrink-0';
  switch (category) {
    case 'document':
    case 'pdf':
    case 'text':
      return <FileText className={iconClass} aria-hidden="true" />;
    case 'presentation':
      return <Presentation className={iconClass} aria-hidden="true" />;
    case 'spreadsheet':
      return <FileSpreadsheet className={iconClass} aria-hidden="true" />;
    case 'image':
      return <ImageIcon className={iconClass} aria-hidden="true" />;
    case 'video':
      return <Film className={iconClass} aria-hidden="true" />;
    case 'audio':
      return <Music className={iconClass} aria-hidden="true" />;
    case 'archive':
      return <FileArchive className={iconClass} aria-hidden="true" />;
    default:
      return <File className={iconClass} aria-hidden="true" />;
  }
}

export default function FileRow({ entry, onDownload, onRemove }: FileRowProps) {
  const typeLabel = getCategoryLabel(entry.category, entry.extension);
  const savings =
    entry.status === 'done' && entry.compressedSize !== null
      ? calculateSavings(entry.originalSize, entry.compressedSize)
      : null;

  return (
    <li className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="flex min-w-0 flex-1 items-start gap-3 sm:items-center">
        <div className="mt-0.5 sm:mt-0">{renderCategoryIcon(entry.category)}</div>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-slate-900">
            {entry.originalName}
          </p>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500">
            <span>{typeLabel}</span>
            {entry.outputExtension &&
              entry.outputExtension !== entry.extension && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>Output {entry.outputExtension.toUpperCase()}</span>
                </>
              )}
            {entry.status === 'compressing' && (
              <>
                <span aria-hidden="true">·</span>
                <span className="inline-flex items-center gap-1 text-blue-700">
                  <Loader2
                    className="h-3 w-3 animate-spin"
                    aria-hidden="true"
                  />
                  Compressing
                </span>
              </>
            )}
            {entry.status === 'pending' && (
              <>
                <span aria-hidden="true">·</span>
                <span>Queued</span>
              </>
            )}
            {entry.status === 'done' && entry.note && (
              <>
                <span aria-hidden="true">·</span>
                <span>{entry.note}</span>
              </>
            )}
            {entry.status === 'error' && (
              <>
                <span aria-hidden="true">·</span>
                <span className="inline-flex items-center gap-1 text-red-700">
                  <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
                  {entry.errorMessage || 'Compression failed'}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 sm:justify-end">
        <div className="flex items-center gap-3 font-mono text-xs tabular-nums sm:text-sm">
          <span className="text-slate-500">
            {formatBytes(entry.originalSize)}
          </span>
          <ArrowRight className="h-3.5 w-3.5 text-slate-400 shrink-0" aria-hidden="true" />
          <span className="min-w-[4.5rem] text-right font-medium text-slate-900">
            {entry.status === 'done' && entry.compressedSize !== null
              ? formatBytes(entry.compressedSize)
              : '—'}
          </span>
          <span
            className={`min-w-[4.25rem] text-right font-medium ${
              savings && savings.savedPercent > 0
                ? 'text-emerald-700'
                : 'text-slate-500'
            }`}
          >
            {savings
              ? savings.savedPercent > 0
                ? `-${savings.savedPercent}%`
                : '0% saved'
              : ''}
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            disabled={entry.status !== 'done' || !entry.blob}
            onClick={() => onDownload(entry)}
            aria-label={`Download ${entry.outputName}`}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-slate-100 px-3 py-2 text-xs font-medium text-slate-800 whitespace-nowrap transition-colors duration-150 hover:bg-slate-200/80 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Download</span>
          </button>

          <button
            type="button"
            onClick={() => onRemove(entry.id)}
            aria-label={`Remove ${entry.originalName}`}
            className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-lg text-slate-400 transition-colors duration-150 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </li>
  );
}
