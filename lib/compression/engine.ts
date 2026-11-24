import {
  buildOutputFileName,
  detectFileCategory,
  getFileExtension,
  getPresetConfig,
  minifyTextContent,
  validateFileSize,
} from './format';
import {
  compressAsZip,
  compressOfficePackage,
  compressPdfBytes,
  isOfficeZipExtension,
  recompressZipArchive,
  type CompressedImageResult,
} from './office-zip';
import type { CompressionLevel, CompressionPresetConfig } from './types';

function resolveConfig(
  input: CompressionLevel | CompressionPresetConfig
): CompressionPresetConfig {
  return typeof input === 'string' ? getPresetConfig(input) : input;
}

function extensionToMime(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'png':
      return 'image/png';
    default:
      return 'image/jpeg';
  }
}

async function decodeImageToCanvas(
  blob: Blob,
  maxDimension: number,
  opaqueBackground: boolean
): Promise<HTMLCanvasElement> {
  let width = 0;
  let height = 0;
  let source: CanvasImageSource;
  let cleanup: (() => void) | null = null;

  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    width = bitmap.width;
    height = bitmap.height;
    source = bitmap;
    cleanup = () => bitmap.close();
  } else {
    const url = URL.createObjectURL(blob);
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Failed to decode image'));
      el.src = url;
    });
    width = img.naturalWidth || img.width;
    height = img.naturalHeight || img.height;
    source = img;
    cleanup = () => URL.revokeObjectURL(url);
  }

  try {
    const scale =
      width > maxDimension || height > maxDimension
        ? Math.min(maxDimension / width, maxDimension / height)
        : 1;
    const targetW = Math.max(1, Math.round(width * scale));
    const targetH = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      throw new Error('Canvas 2D context is unavailable');
    }

    if (opaqueBackground) {
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, targetW, targetH);
    }

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, targetW, targetH);

    return canvas;
  } finally {
    cleanup?.();
  }
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: string,
  quality: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (result) => {
        if (result) {
          resolve(result);
        } else {
          reject(new Error(`Failed to encode ${mimeType}`));
        }
      },
      mimeType,
      quality
    );
  });
}

function quantizeCanvasColors(
  canvas: HTMLCanvasElement,
  step: number
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = imgData.data;
  const half = Math.floor(step / 2);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = Math.min(255, Math.floor((pixels[i] + half) / step) * step);
    pixels[i + 1] = Math.min(
      255,
      Math.floor((pixels[i + 1] + half) / step) * step
    );
    pixels[i + 2] = Math.min(
      255,
      Math.floor((pixels[i + 2] + half) / step) * step
    );
  }
  ctx.putImageData(imgData, 0, 0);
}

export async function compressImageBlob(
  inputBlob: Blob,
  extension: string,
  configInput: CompressionLevel | CompressionPresetConfig
): Promise<{
  blob: Blob;
  outputExtension: string;
  width?: number;
  height?: number;
  note?: string;
}> {
  const config = resolveConfig(configInput);
  const ext = extension.toLowerCase();

  if (ext === 'gif') {
    return {
      blob: inputBlob,
      outputExtension: ext,
      note: 'Original GIF preserved',
    };
  }

  const isJpeg = ext === 'jpg' || ext === 'jpeg' || ext === 'bmp';
  const targetExt = ext === 'bmp' ? 'jpg' : ext;
  const targetMime =
    targetExt === 'png'
      ? 'image/png'
      : targetExt === 'webp'
        ? 'image/webp'
        : 'image/jpeg';

  const canvas = await decodeImageToCanvas(
    inputBlob,
    config.maxDimension,
    isJpeg
  );

  const targetBytes = Math.max(
    128,
    Math.round(inputBlob.size * (1 - config.targetReductionPercent / 100))
  );
  const tolerance = Math.max(512, Math.round(inputBlob.size * 0.05));

  const pickBestBlob = (blobs: Blob[]): Blob | null => {
    let best: Blob | null = null;
    let bestDist = Infinity;
    for (const b of blobs) {
      if (b.size >= inputBlob.size) continue;
      const dist = Math.abs(b.size - targetBytes);
      if (!best || dist < bestDist || (dist === bestDist && b.size < best.size)) {
        best = b;
        bestDist = dist;
      }
    }
    return best;
  };

  if (targetExt === 'png') {
    const lossless = await canvasToBlob(canvas, 'image/png', 1);
    const blobs: Blob[] = [lossless];
    const step =
      config.targetReductionPercent >= 85
        ? 16
        : config.targetReductionPercent >= 65
          ? 8
          : config.targetReductionPercent >= 40
            ? 4
            : 0;
    if (step > 0 && Math.abs(lossless.size - targetBytes) > tolerance && lossless.size > targetBytes) {
      quantizeCanvasColors(canvas, step);
      blobs.push(await canvasToBlob(canvas, 'image/png', config.imageQuality));
    }

    const bestPng = pickBestBlob(blobs);
    if (bestPng) {
      return {
        blob: bestPng,
        outputExtension: 'png',
        width: canvas.width,
        height: canvas.height,
        note: 'PNG optimized',
      };
    }

    return {
      blob: inputBlob,
      outputExtension: 'png',
      note: 'Already optimized',
    };
  }

  const encodedBlobs: Blob[] = [];
  let lo = 0.08;
  let hi = 0.98;
  let q = Math.max(lo, Math.min(hi, 0.98 - (config.targetReductionPercent / 95) * 0.74));
  const tightTolerance = Math.max(256, Math.round(inputBlob.size * 0.025));
  for (let i = 0; i < 5; i += 1) {
    const candidate = await canvasToBlob(canvas, targetMime, q);
    encodedBlobs.push(candidate);
    if (Math.abs(candidate.size - targetBytes) <= tightTolerance) break;
    if (candidate.size > targetBytes) {
      hi = Math.max(lo, q - 0.01);
    } else {
      lo = Math.min(hi, q + 0.01);
    }
    if (lo > hi) break;
    q = (lo + hi) / 2;
  }

  const bestRaster = pickBestBlob(encodedBlobs);
  if (bestRaster) {
    return {
      blob: bestRaster,
      outputExtension: targetExt,
      width: canvas.width,
      height: canvas.height,
    };
  }

  return {
    blob: inputBlob,
    outputExtension: ext,
    note: 'Already optimized',
  };
}

async function compressEmbeddedOfficeImage(
  bytes: Uint8Array,
  ext: string,
  config: CompressionPresetConfig
): Promise<Uint8Array | null> {
  const mime = extensionToMime(ext);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const inputBlob = new Blob([copy], { type: mime });
  const result = await compressImageBlob(inputBlob, ext, config);
  if (result.blob.size >= bytes.byteLength) {
    return null;
  }
  const ab = await result.blob.arrayBuffer();
  return new Uint8Array(ab);
}

async function compressEmbeddedPdfImage(
  bytes: Uint8Array,
  ext: string,
  config: CompressionPresetConfig
): Promise<CompressedImageResult | null> {
  const mime = extensionToMime(ext);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const inputBlob = new Blob([copy], { type: mime });
  const result = await compressImageBlob(inputBlob, ext, config);
  if (result.blob.size >= bytes.byteLength) {
    return null;
  }
  const ab = await result.blob.arrayBuffer();
  return {
    bytes: new Uint8Array(ab),
    width: result.width,
    height: result.height,
  };
}

export interface CompressSingleFileResult {
  blob: Blob;
  outputName: string;
  outputExtension: string;
  note?: string;
}

export async function compressSingleFile(
  file: File,
  configInput: CompressionLevel | CompressionPresetConfig,
  signal?: AbortSignal
): Promise<CompressSingleFileResult> {
  const sizeCheck = validateFileSize(file.size);
  if (!sizeCheck.valid) {
    throw new Error(sizeCheck.error || 'Invalid file size');
  }

  const config = resolveConfig(configInput);

  if (typeof window !== 'undefined' && typeof fetch === 'function') {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('strengthPercent', String(config.targetReductionPercent));

    let response: Response | null = null;
    try {
      response = await fetch('/api/compress', {
        method: 'POST',
        body: formData,
        signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
      // Network error falls through to local fallback below
    }

    if (response) {
      if (response.ok) {
        const blob = await response.blob();
        const ext = getFileExtension(file.name);
        const outputName = decodeURIComponent(
          response.headers.get('X-Output-Name') ||
            buildOutputFileName(file.name, ext)
        );
        const outputExtension = decodeURIComponent(
          response.headers.get('X-Output-Extension') || ext
        );
        const noteHeader = response.headers.get('X-Compression-Note');
        const note = noteHeader ? decodeURIComponent(noteHeader) : undefined;

        return {
          blob,
          outputName,
          outputExtension,
          note,
        };
      }
      const errJson = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (errJson?.error) {
        throw new Error(errJson.error);
      }
      if (response.status === 413) {
        throw new Error('File exceeds maximum 25 MB upload limit');
      }
    }
  }

  const ext = getFileExtension(file.name);
  const category = detectFileCategory(file.name, file.type);

  if (isOfficeZipExtension(ext)) {
    const rawBuffer = await file.arrayBuffer();
    const { buffer, compressedMediaCount, minifiedXmlCount } =
      await compressOfficePackage(
        rawBuffer,
        config,
        compressEmbeddedOfficeImage
      );
    const packedBlob = new Blob([new Uint8Array(buffer)], {
      type: file.type || 'application/octet-stream',
    });
    if (packedBlob.size < file.size) {
      const parts: string[] = [];
      if (compressedMediaCount > 0) {
        parts.push(
          `${compressedMediaCount} ${compressedMediaCount === 1 ? 'image' : 'images'} compressed`
        );
      }
      if (minifiedXmlCount > 0) {
        parts.push('XML compacted');
      }
      return {
        blob: packedBlob,
        outputName: buildOutputFileName(file.name, ext),
        outputExtension: ext,
        note: parts.length > 0 ? parts.join(' · ') : 'Document deflated',
      };
    }
    return {
      blob: file,
      outputName: buildOutputFileName(file.name, ext),
      outputExtension: ext,
      note: 'Already optimized',
    };
  }

  if (category === 'image') {
    const { blob, outputExtension, note } = await compressImageBlob(
      file,
      ext || 'jpg',
      config
    );
    return {
      blob,
      outputName: buildOutputFileName(file.name, outputExtension),
      outputExtension,
      note,
    };
  }

  if (category === 'pdf') {
    const rawBytes = new Uint8Array(await file.arrayBuffer());
    try {
      const { buffer, compressedImagesCount } = await compressPdfBytes(
        rawBytes,
        config,
        compressEmbeddedPdfImage
      );
      if (buffer.byteLength < file.size) {
        return {
          blob: new Blob([new Uint8Array(buffer)], {
            type: 'application/pdf',
          }),
          outputName: buildOutputFileName(file.name, 'pdf'),
          outputExtension: 'pdf',
          note:
            compressedImagesCount > 0
              ? `${compressedImagesCount} PDF images & streams compressed`
              : 'PDF streams compressed',
        };
      }
    } catch {
      // Fallback below
    }

    return {
      blob: file,
      outputName: buildOutputFileName(file.name, 'pdf'),
      outputExtension: 'pdf',
      note: 'Already optimized',
    };
  }

  if (ext === 'zip') {
    try {
      const rawBuffer = await file.arrayBuffer();
      const { buffer } = await recompressZipArchive(
        rawBuffer,
        config,
        compressEmbeddedOfficeImage
      );
      if (buffer.byteLength < file.size) {
        return {
          blob: new Blob([new Uint8Array(buffer)], { type: 'application/zip' }),
          outputName: buildOutputFileName(file.name, 'zip'),
          outputExtension: 'zip',
          note: 'Archive recompressed',
        };
      }
    } catch {
      // Ignore
    }
    return {
      blob: file,
      outputName: buildOutputFileName(file.name, 'zip'),
      outputExtension: 'zip',
      note: 'Already optimized',
    };
  }

  if (category === 'text') {
    const rawText = await file.text();
    const minified = minifyTextContent(rawText, ext);
    const minifiedBlob = new Blob([minified], {
      type: file.type || 'text/plain',
    });
    if (minifiedBlob.size < file.size) {
      return {
        blob: minifiedBlob,
        outputName: buildOutputFileName(file.name, ext || 'txt'),
        outputExtension: ext || 'txt',
        note: ext === 'svg' ? 'SVG minified' : 'Compacted',
      };
    }
    if (['svg', 'json', 'xml', 'html', 'htm', 'css'].includes(ext)) {
      return {
        blob: file,
        outputName: buildOutputFileName(file.name, ext),
        outputExtension: ext,
        note: 'Already compact',
      };
    }
  }

  const rawBuffer = await file.arrayBuffer();
  const zipped = await compressAsZip(
    [{ name: file.name, data: rawBuffer }],
    config
  );
  if (zipped.byteLength < file.size) {
    return {
      blob: new Blob([new Uint8Array(zipped)], { type: 'application/zip' }),
      outputName: buildOutputFileName(file.name, 'zip'),
      outputExtension: 'zip',
      note: 'Compressed',
    };
  }

  return {
    blob: file,
    outputName: buildOutputFileName(file.name, ext),
    outputExtension: ext,
    note: 'Already compact',
  };
}
