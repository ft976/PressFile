'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowRight, Download, RefreshCw, Trash2, Upload } from 'lucide-react';
import Header from '@/components/Header';
import FileRow from '@/components/FileRow';
import { compressSingleFile } from '@/lib/compression/engine';
import {
  detectFileCategory,
  formatBytes,
  getConfigFromStrength,
  getFileExtension,
  getPresetConfig,
  summarizeBatch,
} from '@/lib/compression/format';
import { compressAsZip } from '@/lib/compression/office-zip';
import type {
  CompressedFileEntry,
  CompressionLevel,
  OutputMode,
} from '@/lib/compression/types';

const LEVELS: CompressionLevel[] = ['light', 'balanced', 'maximum'];

export default function CompressorWorkspace() {
  const [strengthPercent, setStrengthPercent] = useState<number>(70);
  const [outputMode, setOutputMode] = useState<OutputMode>('smart');
  const [entries, setEntries] = useState<CompressedFileEntry[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isBundlingZip, setIsBundlingZip] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const entriesRef = useRef<CompressedFileEntry[]>([]);
  const runTokenRef = useRef(0);

  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  useEffect(() => {
    return () => {
      for (const item of entriesRef.current) {
        if (item.objectUrl) {
          URL.revokeObjectURL(item.objectUrl);
        }
      }
    };
  }, []);

  const activeConfig = useMemo(
    () => getConfigFromStrength(strengthPercent),
    [strengthPercent]
  );

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

  const processEntry = useCallback(
    async (
      entryId: string,
      file: File,
      targetStrength: number,
      targetMode: OutputMode,
      token: number
    ) => {
      setEntries((prev) =>
        prev.map((item) =>
          item.id === entryId
            ? { ...item, status: 'compressing', errorMessage: undefined }
            : item
        )
      );

      try {
        const config = getConfigFromStrength(targetStrength);
        const result = await compressSingleFile(file, config, targetMode);
        if (runTokenRef.current !== token) {
          return;
        }
        const objectUrl = URL.createObjectURL(result.blob);
        setEntries((prev) =>
          prev.map((item) => {
            if (item.id !== entryId) return item;
            if (item.objectUrl) {
              URL.revokeObjectURL(item.objectUrl);
            }
            return {
              ...item,
              status: 'done',
              compressedSize: result.blob.size,
              outputName: result.outputName,
              outputExtension: result.outputExtension,
              note: result.note,
              blob: result.blob,
              objectUrl,
            };
          })
        );
      } catch (err) {
        if (runTokenRef.current !== token) {
          return;
        }
        const message =
          err instanceof Error ? err.message : 'Unable to compress this file';
        setEntries((prev) =>
          prev.map((item) =>
            item.id === entryId
              ? {
                  ...item,
                  status: 'error',
                  errorMessage: message,
                }
              : item
          )
        );
      }
    },
    []
  );

  const enqueueFiles = useCallback(
    (fileList: FileList | File[]) => {
      const files = Array.from(fileList);
      if (files.length === 0) return;

      const token = runTokenRef.current;
      const newEntries: CompressedFileEntry[] = files.map((file, idx) => {
        const ext = getFileExtension(file.name);
        return {
          id: `${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 8)}`,
          file,
          originalName: file.name,
          outputName: file.name,
          extension: ext,
          outputExtension: ext,
          category: detectFileCategory(file.name, file.type),
          originalSize: file.size,
          compressedSize: null,
          status: 'pending',
        };
      });

      setEntries((prev) => [...prev, ...newEntries]);

      for (const item of newEntries) {
        void processEntry(item.id, item.file, strengthPercent, outputMode, token);
      }
    },
    [outputMode, processEntry, strengthPercent]
  );

  const handleRecompressAll = useCallback(
    (nextStrength: number, nextMode: OutputMode) => {
      const current = entriesRef.current;
      if (current.length === 0) return;
      runTokenRef.current += 1;
      const token = runTokenRef.current;

      setEntries((prev) =>
        prev.map((item) => ({
          ...item,
          status: 'pending',
          compressedSize: null,
          errorMessage: undefined,
          note: undefined,
        }))
      );

      for (const item of current) {
        void processEntry(item.id, item.file, nextStrength, nextMode, token);
      }
    },
    [processEntry]
  );

  const handlePresetClick = useCallback(
    (nextLevel: CompressionLevel) => {
      const targetStrength = getPresetConfig(nextLevel).targetReductionPercent;
      setStrengthPercent(targetStrength);
      if (entriesRef.current.length > 0) {
        handleRecompressAll(targetStrength, outputMode);
      }
    },
    [handleRecompressAll, outputMode]
  );

  const handleStrengthSliderChange = useCallback((nextStrength: number) => {
    setStrengthPercent(nextStrength);
  }, []);

  const handleStrengthSliderCommit = useCallback(
    (nextStrength: number) => {
      if (entriesRef.current.length > 0) {
        handleRecompressAll(nextStrength, outputMode);
      }
    },
    [handleRecompressAll, outputMode]
  );

  const handleOutputModeChange = useCallback(
    (nextMode: OutputMode) => {
      setOutputMode(nextMode);
      if (entriesRef.current.length > 0) {
        handleRecompressAll(strengthPercent, nextMode);
      }
    },
    [handleRecompressAll, strengthPercent]
  );

  const handleRemove = useCallback((id: string) => {
    setEntries((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target?.objectUrl) {
        URL.revokeObjectURL(target.objectUrl);
      }
      return prev.filter((item) => item.id !== id);
    });
  }, []);

  const handleClearAll = useCallback(() => {
    runTokenRef.current += 1;
    setEntries((prev) => {
      for (const item of prev) {
        if (item.objectUrl) {
          URL.revokeObjectURL(item.objectUrl);
        }
      }
      return [];
    });
  }, []);

  const handleDownloadSingle = useCallback(
    (entry: CompressedFileEntry) => {
      if (!entry.blob) return;
      triggerDownload(entry.blob, entry.outputName);
    },
    [triggerDownload]
  );

  const handleDownloadAll = useCallback(async () => {
    const doneItems = entries.filter(
      (item) => item.status === 'done' && item.blob
    );
    if (doneItems.length === 0) return;

    if (doneItems.length === 1 && doneItems[0].blob) {
      triggerDownload(doneItems[0].blob, doneItems[0].outputName);
      return;
    }

    setIsBundlingZip(true);
    try {
      const payload = await Promise.all(
        doneItems.map(async (item) => ({
          name: item.outputName,
          data: new Uint8Array(await item.blob!.arrayBuffer()),
        }))
      );
      const archiveBytes = await compressAsZip(payload, activeConfig);
      const archiveBlob = new Blob([new Uint8Array(archiveBytes)], {
        type: 'application/zip',
      });
      triggerDownload(archiveBlob, 'compressed-files.zip');
    } finally {
      setIsBundlingZip(false);
    }
  }, [activeConfig, entries, triggerDownload]);

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
        enqueueFiles(event.dataTransfer.files);
      }
    },
    [enqueueFiles]
  );

  const summary = useMemo(() => summarizeBatch(entries), [entries]);
  const totalQueuedBytes = useMemo(
    () => entries.reduce((sum, item) => sum + item.originalSize, 0),
    [entries]
  );

  const remainingRatio =
    summary.totalOriginal > 0
      ? Math.max(
          2,
          Math.min(
            100,
            Math.round((summary.totalCompressed / summary.totalOriginal) * 100)
          )
        )
      : Math.max(5, 100 - strengthPercent);

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
            DOCX, PPTX, PDF, MP4, MP3, images, and all formats.
          </p>
        </section>

        <section aria-label="Upload files" className="mt-7">
          <input
            ref={fileInputRef}
            data-testid="file-input"
            type="file"
            multiple
            accept="*/*"
            onChange={(event) => {
              if (event.target.files) {
                enqueueFiles(event.target.files);
                event.target.value = '';
              }
            }}
            className="sr-only"
            aria-label="Choose files to compress"
          />

          <button
            type="button"
            onClick={handleTriggerUpload}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`flex w-full cursor-pointer flex-col items-center justify-center rounded-lg px-6 text-center transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ${
              entries.length > 0 ? 'py-7' : 'py-14'
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
                ? 'Drop files here'
                : entries.length > 0
                  ? 'Add more files'
                  : 'Drop files or click to browse'}
            </span>
          </button>
        </section>

        <AnimatePresence>
          {entries.length > 0 && (
            <motion.div
              key="compression-workspace"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            >
              <section
                aria-label="Compression settings"
                data-testid="compression-controls"
                className="mt-8 border-b border-slate-200 pb-6"
              >
                <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <span className="block text-xs font-medium text-slate-500">
                      Compression Level
                    </span>
                    <div
                      role="group"
                      aria-label="Compression Level"
                      className="mt-2 flex items-center gap-4 border-b border-slate-200"
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

                  <div>
                    <span className="block text-xs font-medium text-slate-500">
                      Output Format
                    </span>
                    <div
                      role="group"
                      aria-label="Output Format"
                      className="mt-2 flex items-center gap-4 border-b border-slate-200"
                    >
                      <button
                        type="button"
                        onClick={() => handleOutputModeChange('smart')}
                        aria-pressed={outputMode === 'smart'}
                        className={`-mb-px border-b-2 pb-2 text-sm font-medium whitespace-nowrap shrink-0 transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ${
                          outputMode === 'smart'
                            ? 'border-blue-600 text-slate-900'
                            : 'border-transparent text-slate-500 hover:text-slate-900'
                        }`}
                      >
                        Keep Format
                      </button>
                      <button
                        type="button"
                        onClick={() => handleOutputModeChange('zip')}
                        aria-pressed={outputMode === 'zip'}
                        className={`-mb-px border-b-2 pb-2 text-sm font-medium whitespace-nowrap shrink-0 transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ${
                          outputMode === 'zip'
                            ? 'border-blue-600 text-slate-900'
                            : 'border-transparent text-slate-500 hover:text-slate-900'
                        }`}
                      >
                        Pack as ZIP
                      </button>
                    </div>
                  </div>
                </div>

                <div data-testid="compression-bar" className="mt-6 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs sm:text-sm">
                    <div className="flex items-center gap-2 font-mono tabular-nums text-slate-700">
                      {summary.completedFiles > 0 ? (
                        <>
                          <span>{formatBytes(summary.totalOriginal)}</span>
                          <ArrowRight
                            className="h-3.5 w-3.5 text-slate-400"
                            aria-hidden="true"
                          />
                          <span className="font-medium text-slate-900">
                            {formatBytes(summary.totalCompressed)}
                          </span>
                        </>
                      ) : (
                        <span>{formatBytes(totalQueuedBytes)}</span>
                      )}
                    </div>

                    <div className="flex items-center gap-2 text-xs font-mono tabular-nums">
                      <span className="text-slate-500">
                        Up to {strengthPercent}%
                      </span>
                      {summary.completedFiles > 0 && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-medium text-emerald-700">
                            {summary.totalSavedPercent > 0
                              ? `${summary.totalSavedPercent}% reduced`
                              : '0% reduced'}
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  <div
                    aria-hidden="true"
                    className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100"
                  >
                    <div
                      className="h-full rounded-full bg-blue-600 transition-[width] duration-200"
                      style={{ width: `${remainingRatio}%` }}
                    />
                  </div>

                  <div className="pt-1">
                    <div className="flex items-center justify-between text-xs text-slate-500">
                      <label htmlFor="compression-strength-slider">
                        Strength
                      </label>
                      <span className="font-mono tabular-nums text-slate-700">
                        Up to {strengthPercent}%
                      </span>
                    </div>
                    <input
                      id="compression-strength-slider"
                      type="range"
                      min={10}
                      max={95}
                      step={5}
                      value={strengthPercent}
                      onChange={(event) =>
                        handleStrengthSliderChange(Number(event.target.value))
                      }
                      onMouseUp={(event) =>
                        handleStrengthSliderCommit(
                          Number((event.target as HTMLInputElement).value)
                        )
                      }
                      onTouchEnd={(event) =>
                        handleStrengthSliderCommit(
                          Number((event.target as HTMLInputElement).value)
                        )
                      }
                      onKeyUp={(event) =>
                        handleStrengthSliderCommit(
                          Number((event.target as HTMLInputElement).value)
                        )
                      }
                      className="mt-1 h-1.5 w-full cursor-pointer accent-blue-600"
                    />
                  </div>
                </div>
              </section>

              <section
                data-testid="file-queue"
                aria-label="Compressed files"
                className="mt-7"
              >
                <div className="flex flex-col gap-4 pb-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-600">
                    <span className="font-medium text-slate-900 tabular-nums">
                      {summary.totalFiles}{' '}
                      {summary.totalFiles === 1 ? 'file' : 'files'}
                    </span>
                    {summary.completedFiles > 0 && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="inline-flex items-center gap-1.5 font-mono text-xs tabular-nums sm:text-sm">
                          <span>{formatBytes(summary.totalOriginal)}</span>
                          <ArrowRight
                            className="h-3.5 w-3.5 text-slate-400"
                            aria-hidden="true"
                          />
                          <span>{formatBytes(summary.totalCompressed)}</span>
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="font-medium text-emerald-700 tabular-nums">
                          {summary.totalSavedPercent > 0
                            ? `${summary.totalSavedPercent}% saved`
                            : 'Already compact'}
                        </span>
                      </>
                    )}
                  </div>

                  <div className="flex items-center gap-3 shrink-0">
                    <button
                      type="button"
                      onClick={() =>
                        handleRecompressAll(strengthPercent, outputMode)
                      }
                      disabled={summary.processingFiles > 0}
                      className="inline-flex min-h-10 items-center gap-1.5 px-2 py-2 text-xs font-medium text-slate-600 whitespace-nowrap transition-colors duration-150 hover:text-slate-900 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                    >
                      <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Recompress</span>
                    </button>

                    <button
                      type="button"
                      onClick={handleClearAll}
                      className="inline-flex min-h-10 items-center gap-1.5 px-2 py-2 text-xs font-medium text-slate-600 whitespace-nowrap transition-colors duration-150 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Clear All</span>
                    </button>

                    <button
                      type="button"
                      disabled={summary.completedFiles === 0 || isBundlingZip}
                      onClick={handleDownloadAll}
                      className="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white whitespace-nowrap transition-colors duration-150 hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                    >
                      <Download className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>
                        {isBundlingZip
                          ? 'Preparing...'
                          : summary.completedFiles > 1
                            ? 'Download All (.zip)'
                            : 'Download'}
                      </span>
                    </button>
                  </div>
                </div>

                <ul className="divide-y divide-slate-100 border-t border-slate-200">
                  {entries.map((entry) => (
                    <FileRow
                      key={entry.id}
                      entry={entry}
                      onDownload={handleDownloadSingle}
                      onRemove={handleRemove}
                    />
                  ))}
                </ul>
              </section>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <footer className="border-t border-slate-100 bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-4 text-xs text-slate-400 sm:px-8">
          <span>PressFile</span>
          <span>Fast advanced compression</span>
        </div>
      </footer>
    </div>
  );
}
