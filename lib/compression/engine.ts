import {
  buildOutputFileName,
  detectFileCategory,
  getFileExtension,
  getPresetConfig,
  minifyTextContent,
} from './format';
import {
  compressAsZip,
  compressOfficePackage,
  compressPdfBytes,
  isOfficeZipExtension,
  recompressZipArchive,
  type CompressedImageResult,
} from './office-zip';
import type {
  CompressionLevel,
  CompressionPresetConfig,
  OutputMode,
} from './types';

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

function hasTransparentPixels(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  const { width, height } = canvas;
  const stepX = Math.max(1, Math.floor(width / 64));
  const stepY = Math.max(1, Math.floor(height / 64));
  const data = ctx.getImageData(0, 0, width, height).data;
  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha < 250) {
        return true;
      }
    }
  }
  return false;
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

  if (targetExt === 'png') {
    const transparent = hasTransparentPixels(canvas);
    if (config.targetReductionPercent >= 85) {
      quantizeCanvasColors(canvas, 28);
    } else if (config.targetReductionPercent >= 65) {
      quantizeCanvasColors(canvas, 14);
    } else if (config.targetReductionPercent >= 40) {
      quantizeCanvasColors(canvas, 6);
    }

    const pngBlob = await canvasToBlob(canvas, 'image/png', config.imageQuality);
    if (pngBlob.size < inputBlob.size) {
      return {
        blob: pngBlob,
        outputExtension: 'png',
        width: canvas.width,
        height: canvas.height,
        note: transparent ? 'PNG optimized' : 'PNG palette optimized',
      };
    }

    return {
      blob: inputBlob,
      outputExtension: 'png',
      note: 'Already optimized',
    };
  }

  const encoded = await canvasToBlob(canvas, targetMime, config.imageQuality);
  if (encoded.size < inputBlob.size) {
    return {
      blob: encoded,
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
  outputMode: OutputMode
): Promise<CompressSingleFileResult> {
  if (file.size === 0) {
    throw new Error('File is empty');
  }

  const config = resolveConfig(configInput);

  if (typeof window !== 'undefined' && typeof fetch === 'function') {
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('strengthPercent', String(config.targetReductionPercent));
      formData.append('outputMode', outputMode);

      const response = await fetch('/api/compress', {
        method: 'POST',
        body: formData,
      });

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
    } catch {
      // Fall back to local browser compression if server endpoint is unavailable
    }
  }

  const ext = getFileExtension(file.name);
  const category = detectFileCategory(file.name, file.type);

  if (outputMode === 'zip') {
    const rawBuffer = await file.arrayBuffer();
    const zipped = await compressAsZip(
      [{ name: file.name, data: rawBuffer }],
      config
    );
    const zipBlob = new Blob([new Uint8Array(zipped)], {
      type: 'application/zip',
    });
    return {
      blob: zipBlob,
      outputName: buildOutputFileName(file.name, 'zip'),
      outputExtension: 'zip',
      note: 'Compressed into ZIP',
    };
  }

  // 1. Modern Office OpenXML / ODF (DOCX, PPTX, XLSX, ODT, ODP, ODS)
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

  // 2. Raster Images (JPG, PNG, WebP, BMP, AVIF)
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

  // 3. PDF Documents (object streams + metadata stripping + embedded JPEG re-compression)
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
              ? `${compressedImagesCount} PDF ${compressedImagesCount === 1 ? 'image' : 'images'} & streams compressed`
              : 'PDF streams compressed',
        };
      }
    } catch {
      // Fallback below if PDF uses unsupported features
    }

    const zipped = await compressAsZip(
      [{ name: file.name, data: rawBytes }],
      config
    );
    if (zipped.byteLength < file.size) {
      return {
        blob: new Blob([new Uint8Array(zipped)], { type: 'application/zip' }),
        outputName: buildOutputFileName(file.name, 'zip'),
        outputExtension: 'zip',
        note: 'Packed as ZIP',
      };
    }
    return {
      blob: file,
      outputName: buildOutputFileName(file.name, 'pdf'),
      outputExtension: 'pdf',
      note: 'Already optimized',
    };
  }

  // 4. ZIP Archives (recompress internal media + DEFLATE level 9)
  if (ext === 'zip') {
    try {
      const rawBuffer = await file.arrayBuffer();
      const { buffer, compressedMediaCount } = await recompressZipArchive(
        rawBuffer,
        config,
        compressEmbeddedOfficeImage
      );
      if (buffer.byteLength < file.size) {
        return {
          blob: new Blob([new Uint8Array(buffer)], { type: 'application/zip' }),
          outputName: buildOutputFileName(file.name, 'zip'),
          outputExtension: 'zip',
          note:
            compressedMediaCount > 0
              ? `${compressedMediaCount} images & archive recompressed`
              : 'Archive recompressed',
        };
      }
    } catch {
      // Preserve original if zip is encrypted or malformed
    }
    return {
      blob: file,
      outputName: buildOutputFileName(file.name, 'zip'),
      outputExtension: 'zip',
      note: 'Already optimized',
    };
  }

  // 5. Text / SVG / JSON / Code
  if (category === 'text') {
    const rawText = await file.text();
    const minified = minifyTextContent(rawText, ext);
    const minifiedBlob = new Blob([minified], {
      type: file.type || 'text/plain',
    });
    const minificationSavedRatio = (file.size - minifiedBlob.size) / file.size;
    if (minificationSavedRatio >= 0.05) {
      return {
        blob: minifiedBlob,
        outputName: buildOutputFileName(file.name, ext || 'txt'),
        outputExtension: ext || 'txt',
        note: ext === 'svg' ? 'SVG minified' : 'Compacted',
      };
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
        note: 'Compressed into ZIP',
      };
    }
    if (minifiedBlob.size < file.size) {
      return {
        blob: minifiedBlob,
        outputName: buildOutputFileName(file.name, ext || 'txt'),
        outputExtension: ext || 'txt',
        note: 'Compacted',
      };
    }
    return {
      blob: file,
      outputName: buildOutputFileName(file.name, ext || 'txt'),
      outputExtension: ext || 'txt',
      note: 'Already compact',
    };
  }

  // 6. Legacy DOC / PPT / Any other file format -> DEFLATE ZIP compression
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
      note: 'Compressed into ZIP',
    };
  }

  return {
    blob: file,
    outputName: buildOutputFileName(file.name, ext),
    outputExtension: ext,
    note: 'Already compressed',
  };
}
