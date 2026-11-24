'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertCircle, ArrowRight, Loader2, Upload } from 'lucide-react';
import Header from '@/components/Header';
import FileRow from '@/components/FileRow';
import {
  compressSingleFile,
  type CompressSingleFileResult,
} from '@/lib/compression/engine';
import {
  calculateSavings,
  detectFileCategory,
  formatBytes,
  getConfigFromStrength,
  getFileExtension,
  getPresetConfig,
  validateFileSize,
} from '@/lib/compression/format';
import {
  MAX_FILE_SIZE_BYTES,
  type CompressedFileEntry,
  type CompressionLevel,
} from '@/lib/compression/types';

const LEVELS: CompressionLevel[] = ['light', 'balanced', 'maximum'];

export default function CompressorWorkspace() {
  const [strengthPercent, setStrengthPercent] = useState<number>(70);
  const [entry, setEntry] = useState<CompressedFileEntry | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const entryRef = useRef<CompressedFileEntry | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const debounceTimerRef = useRef<number | null>(null);
  const runIdRef = useRef(0);
  const resultCacheRef = useRef<Map<number, CompressSingleFileResult>>(
    new Map()
  );

  useEffect(() => {
    entryRef.current = entry;
  }, [entry]);

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
      }
      if (entryRef.current?.objectUrl) {
        URL.revokeObjectURL(entryRef.current.objectUrl);
      }
    };
  }, []);

  const triggerDownload = useCallback((blob: Blob, fileName: string) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, []);

  const applyResultToEntry = useCallback(
    (entryId: string, result: CompressSingleFileResult) => {
      const objectUrl = URL.createObjectURL(result.blob);
      setEntry((prev) => {
        if (!prev || prev.id !== entryId) {
          URL.revokeObjectURL(objectUrl);
          return prev;
        }
        if (prev.objectUrl) {
          URL.revokeObjectURL(prev.objectUrl);
        }
        return {
          ...prev,
          status: 'done',
          compressedSize: result.blob.size,
          outputName: result.outputName,
          outputExtension: result.outputExtension,
          note: result.note,
          blob: result.blob,
          objectUrl,
        };
      });
    },
    []
  );

  const runCompression = useCallback(
    async (file: File, entryId: string, targetStrength: number) => {
      abortControllerRef.current?.abort();

      const cached = resultCacheRef.current.get(targetStrength);
      if (cached) {
        runIdRef.current += 1;
        applyResultToEntry(entryId, cached);
        return;
      }

      const controller = new AbortController();
      abortControllerRef.current = controller;

      runIdRef.current += 1;
      const currentRunId = runIdRef.current;

      setEntry((prev) =>
        prev && prev.id === entryId
          ? {
              ...prev,
              status: 'compressing',
              errorMessage: undefined,
            }
          : prev
      );

      try {
        const config = getConfigFromStrength(targetStrength);
        const result = await compressSingleFile(
          file,
          config,
          controller.signal
        );

        if (runIdRef.current !== currentRunId) {
          return;
        }

        resultCacheRef.current.set(targetStrength, result);
        applyResultToEntry(entryId, result);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }
        if (runIdRef.current !== currentRunId) {
          return;
        }
        const message =
          err instanceof Error ? err.message : 'Unable to compress this file';
        setEntry((prev) =>
          prev && prev.id === entryId
            ? {
                ...prev,
                status: 'error',
                errorMessage: message,
              }
            : prev
        );
      }
    },
    [applyResultToEntry]
  );

  const selectSingleFile = useCallback(
    (fileList: FileList | File[]) => {
      const files = Array.from(fileList);
      if (files.length === 0) return;

      if (files.length > 1) {
        setValidationError('Select one file at a time (max 25 MB).');
        return;
      }

      const file = files[0];
      const sizeCheck = validateFileSize(file.size, MAX_FILE_SIZE_BYTES);
      if (!sizeCheck.valid) {
        setValidationError(sizeCheck.error || 'File exceeds 25 MB limit.');
        return;
      }

      setValidationError(null);
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      resultCacheRef.current.clear();

      if (entryRef.current?.objectUrl) {
        URL.revokeObjectURL(entryRef.current.objectUrl);
      }

      const ext = getFileExtension(file.name);
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const nextEntry: CompressedFileEntry = {
        id,
        file,
        originalName: file.name,
        outputName: file.name,
        extension: ext,
        outputExtension: ext,
        category: detectFileCategory(file.name, file.type),
        originalSize: file.size,
        compressedSize: null,
        status: 'compressing',
      };

      setEntry(nextEntry);
      void runCompression(file, id, strengthPercent);
    },
    [runCompression, strengthPercent]
  );

  const handlePresetClick = useCallback(
    (nextLevel: CompressionLevel) => {
      const targetStrength = getPresetConfig(nextLevel).targetReductionPercent;
      setStrengthPercent(targetStrength);
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      const current = entryRef.current;
      if (current) {
        void runCompression(current.file, current.id, targetStrength);
      }
    },
    [runCompression]
  );

  const handleStrengthChange = useCallback(
    (nextStrength: number) => {
      const clamped = Math.max(10, Math.min(95, Math.round(nextStrength)));
      setStrengthPercent(clamped);
      const current = entryRef.current;
      if (!current) return;

      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
      }

      const cached = resultCacheRef.current.get(clamped);
      if (cached) {
        debounceTimerRef.current = null;
        void runCompression(current.file, current.id, clamped);
        return;
      }

      // Immediately cancel any stale in-flight compression so old results cannot overwrite new slider values
      abortControllerRef.current?.abort();
      runIdRef.current += 1;

      setEntry((prev) =>
        prev && prev.id === current.id
          ? { ...prev, status: 'compressing', errorMessage: undefined }
          : prev
      );

      debounceTimerRef.current = window.setTimeout(() => {
        debounceTimerRef.current = null;
        const latest = entryRef.current;
        if (latest) {
          void runCompression(latest.file, latest.id, clamped);
        }
      }, 90);
    },
    [runCompression]
  );

  const handleClear = useCallback(() => {
    abortControllerRef.current?.abort();
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    resultCacheRef.current.clear();
    if (entryRef.current?.objectUrl) {
      URL.revokeObjectURL(entryRef.current.objectUrl);
    }
    setEntry(null);
    setValidationError(null);
  }, []);

  const handleDownload = useCallback(
    (item: CompressedFileEntry) => {
      if (!item.blob) return;
      triggerDownload(item.blob, item.outputName);
    },
    [triggerDownload]
  );

  const handleTriggerUpload = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setIsDragging(false);
      if (event.dataTransfer.files && event.dataTransfer.files.length > 0) {
        selectSingleFile(event.dataTransfer.files);
      }
    },
    [selectSingleFile]
  );

  const hasCompressedValue = entry !== null && entry.compressedSize !== null;
  const savings =
    entry && entry.compressedSize !== null
      ? calculateSavings(entry.originalSize, entry.compressedSize)
      : null;

  const remainingRatio =
    entry && entry.compressedSize !== null
      ? Math.max(
          2,
          Math.min(
            100,
            Math.round((entry.compressedSize / entry.originalSize) * 100)
          )
        )
      : 100;

  return (
    <div className="flex min-h-screen flex-col bg-white text-slate-900">
      <Header onTriggerUpload={handleTriggerUpload} />

      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8 sm:px-8 sm:py-10">
        <section aria-labelledby="compressor-heading">
          <h1
            id="compressor-heading"
            className="text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl"
          >
            Compress any file
          </h1>
          <p className="mt-2 text-base text-slate-500">
            DOCX, PPTX, PDF, MP4, MP3, images, and all formats. Max 25 MB.
          </p>
        </section>

        <section aria-label="Upload file" className="mt-7">
          <input
            ref={fileInputRef}
            data-testid="file-input"
            type="file"
            accept="*/*"
            onChange={(event) => {
              if (event.target.files) {
                selectSingleFile(event.target.files);
                event.target.value = '';
              }
            }}
            className="sr-only"
            aria-label="Choose a file to compress"
          />

          <button
            type="button"
            onClick={handleTriggerUpload}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`flex w-full cursor-pointer flex-col items-center justify-center rounded-lg px-6 text-center transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ${
              entry ? 'py-7' : 'py-14'
            } ${
              isDragging
                ? 'bg-blue-50 text-blue-900'
                : 'bg-slate-50 hover:bg-slate-100/80'
            }`}
          >
            <Upload
              className={`h-6 w-6 transition-colors duration-150 ${
                isDragging ? 'text-blue-600' : 'text-slate-400'
              }`}
              aria-hidden="true"
            />
            <span className="mt-2.5 text-sm font-medium text-slate-900 sm:text-base">
              {isDragging
                ? 'Drop file here'
                : entry
                  ? 'Replace file'
                  : 'Drop a file or click to browse'}
            </span>
          </button>

          {validationError && (
            <p
              role="alert"
              data-testid="validation-error"
              className="mt-3 flex items-center gap-1.5 text-sm text-red-700"
            >
              <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{validationError}</span>
            </p>
          )}
        </section>

        <AnimatePresence>
          {entry && (
            <motion.div
              key="compression-workspace"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            >
              <section
                aria-label="Compression level"
                data-testid="compression-controls"
                className="mt-8 border-b border-slate-200 pb-6"
              >
                <div>
                  <span className="block text-xs font-medium text-slate-500">
                    Compression Level
                  </span>
                  <div
                    role="group"
                    aria-label="Compression Level"
                    className="mt-2 flex items-center gap-5 border-b border-slate-200"
                  >
                    {LEVELS.map((itemLevel) => {
                      const cfg = getPresetConfig(itemLevel);
                      const isSelected =
                        strengthPercent === cfg.targetReductionPercent;
                      return (
                        <button
                          key={itemLevel}
                          type="button"
                          onClick={() => handlePresetClick(itemLevel)}
                          aria-pressed={isSelected}
                          className={`-mb-px border-b-2 pb-2 text-sm font-medium whitespace-nowrap shrink-0 transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ${
                            isSelected
                              ? 'border-blue-600 text-slate-900'
                              : 'border-transparent text-slate-500 hover:text-slate-900'
                          }`}
                        >
                          {cfg.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div data-testid="compression-bar" className="mt-5 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs sm:text-sm">
                    <div className="flex items-center gap-2 font-mono tabular-nums text-slate-700">
                      <span>{formatBytes(entry.originalSize)}</span>
                      <ArrowRight
                        className="h-3.5 w-3.5 text-slate-400"
                        aria-hidden="true"
                      />
                      <span
                        className={`font-medium text-slate-900 transition-opacity duration-150 ${
                          entry.status === 'compressing' && hasCompressedValue
                            ? 'opacity-60'
                            : 'opacity-100'
                        }`}
                      >
                        {hasCompressedValue && entry.compressedSize !== null
                          ? formatBytes(entry.compressedSize)
                          : 'Compressing...'}
                      </span>
                      {entry.status === 'compressing' && hasCompressedValue && (
                        <Loader2
                          className="h-3.5 w-3.5 animate-spin text-blue-600"
                          aria-label="Updating compressed size"
                        />
                      )}
                    </div>

                    <div className="flex items-center gap-2 text-xs font-mono tabular-nums">
                      {savings ? (
                        <span
                          className={`font-medium ${
                            savings.savedPercent > 0
                              ? 'text-emerald-700'
                              : 'text-slate-500'
                          }`}
                        >
                          {savings.savedPercent > 0
                            ? `${savings.savedPercent}% reduced (${formatBytes(savings.savedBytes)} saved)`
                            : 'Already optimized'}
                        </span>
                      ) : (
                        <span className="text-slate-400">
                          Compressing at {strengthPercent}%
                        </span>
                      )}
                    </div>
                  </div>

                  <div
                    aria-hidden="true"
                    className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100"
                  >
                    <div
                      className="h-full rounded-full bg-blue-600 transition-[width] duration-200 ease-out"
                      style={{ width: `${remainingRatio}%` }}
                    />
                  </div>

                  <div className="pt-1">
                    <div className="flex items-center justify-between text-xs text-slate-500">
                      <label htmlFor="compression-strength-slider">
                        Strength
                      </label>
                      <span className="font-mono tabular-nums text-slate-700">
                        {strengthPercent}%
                      </span>
                    </div>
                    <input
                      id="compression-strength-slider"
                      type="range"
                      min={10}
                      max={95}
                      step={1}
                      value={strengthPercent}
                      onChange={(event) =>
                        handleStrengthChange(Number(event.target.value))
                      }
                      className="mt-1 h-1.5 w-full cursor-pointer accent-blue-600"
                    />
                  </div>
                </div>
              </section>

              <section
                data-testid="file-queue"
                aria-label="Compressed file"
                className="mt-4"
              >
                <ul className="divide-y divide-slate-100">
                  <FileRow
                    entry={entry}
                    onDownload={handleDownload}
                    onRemove={handleClear}
                  />
                </ul>
              </section>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <footer className="border-t border-slate-100 bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-4 text-xs text-slate-400 sm:px-8">
          <span>PressFile</span>
          <span>Real-time compression · Max 25 MB</span>
        </div>
      </footer>
    </div>
  );
}
