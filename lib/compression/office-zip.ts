import JSZip from 'jszip';
import { PDFDocument, PDFName, PDFNumber, PDFRawStream } from 'pdf-lib';
import {
  getFileExtension,
  getPresetConfig,
  minifyXmlContent,
} from './format';
import type { CompressionLevel, CompressionPresetConfig } from './types';

export type CompressionConfigInput = CompressionLevel | CompressionPresetConfig;

function resolveConfig(input: CompressionConfigInput): CompressionPresetConfig {
  return typeof input === 'string' ? getPresetConfig(input) : input;
}

export interface CompressedImageResult {
  bytes: Uint8Array;
  width?: number;
  height?: number;
  convertedExtension?: string;
}

export type EmbeddedImageCompressor = (
  bytes: Uint8Array,
  extension: string,
  config: CompressionPresetConfig
) => Promise<Uint8Array | CompressedImageResult | null>;

export type EmbeddedPdfImageCompressor = (
  bytes: Uint8Array,
  extension: string,
  config: CompressionPresetConfig
) => Promise<CompressedImageResult | null>;

const COMPRESSIBLE_MEDIA_EXTS = new Set([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'bmp',
  'tif',
  'tiff',
  'gif',
]);

export function isOfficeZipExtension(extension: string): boolean {
  const ext = extension.toLowerCase();
  return (
    ext === 'docx' ||
    ext === 'pptx' ||
    ext === 'xlsx' ||
    ext === 'odt' ||
    ext === 'odp' ||
    ext === 'ods'
  );
}

export function ensureOoxmlContentType(
  contentTypesXml: string,
  extension: string,
  mimeType: string
): string {
  const extLower = extension.toLowerCase();
  const hasDefault = new RegExp(
    `Extension=["']${extLower}["']`,
    'i'
  ).test(contentTypesXml);
  if (hasDefault) {
    return contentTypesXml;
  }
  return contentTypesXml.replace(
    '</Types>',
    `<Default Extension="${extLower}" ContentType="${mimeType}"/></Types>`
  );
}

export async function compressOfficePackage(
  data: ArrayBuffer | Uint8Array,
  configInput: CompressionConfigInput,
  compressEmbeddedImage?: EmbeddedImageCompressor
): Promise<{
  buffer: Uint8Array;
  compressedMediaCount: number;
  minifiedXmlCount: number;
}> {
  const config = resolveConfig(configInput);
  const zip = await JSZip.loadAsync(data);
  let compressedMediaCount = 0;
  let minifiedXmlCount = 0;
  const renamedPaths = new Map<string, string>();
  const addedContentTypes = new Map<string, string>();

  const entryPaths = Object.keys(zip.files);
  const mediaJobs: Array<() => Promise<void>> = [];

  for (const path of entryPaths) {
    const zipEntry = zip.files[path];
    if (!zipEntry || zipEntry.dir) continue;

    const lowerPath = path.toLowerCase();

    if (
      config.targetReductionPercent >= 35 &&
      lowerPath.startsWith('docprops/thumbnail.')
    ) {
      zip.remove(path);
      continue;
    }

    const isMediaFolder =
      lowerPath.includes('/media/') || lowerPath.startsWith('pictures/');
    const ext = getFileExtension(path);

    if (
      compressEmbeddedImage &&
      isMediaFolder &&
      COMPRESSIBLE_MEDIA_EXTS.has(ext)
    ) {
      mediaJobs.push(async () => {
        const originalBytes = await zipEntry.async('uint8array');
        try {
          const result = await compressEmbeddedImage(originalBytes, ext, config);
          if (!result) return;

          const outBytes =
            result instanceof Uint8Array ? result : result.bytes;
          const convertedExt =
            result instanceof Uint8Array ? undefined : result.convertedExtension;

          if (outBytes.byteLength < originalBytes.byteLength) {
            if (convertedExt && convertedExt !== ext) {
              const newPath = path.replace(
                new RegExp(`\\.${ext}$`, 'i'),
                `.${convertedExt}`
              );
              zip.remove(path);
              zip.file(newPath, outBytes, {
                compression: 'DEFLATE',
                compressionOptions: { level: config.zipLevel },
              });
              renamedPaths.set(path, newPath);
              if (convertedExt === 'jpg' || convertedExt === 'jpeg') {
                addedContentTypes.set(convertedExt, 'image/jpeg');
              }
            } else {
              zip.file(path, outBytes, {
                compression: 'DEFLATE',
                compressionOptions: { level: config.zipLevel },
              });
            }
            compressedMediaCount += 1;
          }
        } catch {
          // Keep original embedded media entry if image re-encoding fails
        }
      });
    }
  }

  // Run embedded media compression in parallel batches of 4
  for (let i = 0; i < mediaJobs.length; i += 4) {
    await Promise.all(mediaJobs.slice(i, i + 4).map((job) => job()));
  }

  // Update .rels targets, [Content_Types].xml, and minify XML/RELS
  const updatedPaths = Object.keys(zip.files);
  for (const path of updatedPaths) {
    const zipEntry = zip.files[path];
    if (!zipEntry || zipEntry.dir) continue;
    const ext = getFileExtension(path);
    if (ext !== 'xml' && ext !== 'rels') continue;

    try {
      let xmlText = await zipEntry.async('string');
      let modified = false;

      if (renamedPaths.size > 0 && ext === 'rels') {
        for (const [oldPath, newPath] of renamedPaths.entries()) {
          const oldFileName = oldPath.split('/').pop();
          const newFileName = newPath.split('/').pop();
          if (oldFileName && newFileName && xmlText.includes(oldFileName)) {
            xmlText = xmlText.split(oldFileName).join(newFileName);
            modified = true;
          }
        }
      }

      if (
        addedContentTypes.size > 0 &&
        path.toLowerCase() === '[content_types].xml'
      ) {
        for (const [extName, mime] of addedContentTypes.entries()) {
          const updated = ensureOoxmlContentType(xmlText, extName, mime);
          if (updated !== xmlText) {
            xmlText = updated;
            modified = true;
          }
        }
      }

      if (config.targetReductionPercent >= 50) {
        const minified = minifyXmlContent(xmlText);
        if (minified.length > 0 && minified.length < xmlText.length) {
          xmlText = minified;
          modified = true;
          minifiedXmlCount += 1;
        }
      }

      if (modified) {
        zip.file(path, xmlText, {
          compression: 'DEFLATE',
          compressionOptions: { level: config.zipLevel },
        });
      }
    } catch {
      // Preserve original XML if decoding fails
    }
  }

  const buffer = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: {
      level: config.zipLevel,
    },
  });

  return { buffer, compressedMediaCount, minifiedXmlCount };
}

export async function recompressZipArchive(
  data: ArrayBuffer | Uint8Array,
  configInput: CompressionConfigInput,
  compressEmbeddedImage?: EmbeddedImageCompressor
): Promise<{ buffer: Uint8Array; compressedMediaCount: number }> {
  const config = resolveConfig(configInput);
  const zip = await JSZip.loadAsync(data);
  let compressedMediaCount = 0;

  const entryPaths = Object.keys(zip.files);
  for (const path of entryPaths) {
    const zipEntry = zip.files[path];
    if (!zipEntry || zipEntry.dir) continue;
    const ext = getFileExtension(path);
    if (compressEmbeddedImage && COMPRESSIBLE_MEDIA_EXTS.has(ext)) {
      const originalBytes = await zipEntry.async('uint8array');
      try {
        const result = await compressEmbeddedImage(originalBytes, ext, config);
        if (!result) continue;
        const optimized =
          result instanceof Uint8Array ? result : result.bytes;
        if (optimized.byteLength < originalBytes.byteLength) {
          zip.file(path, optimized, {
            compression: 'DEFLATE',
            compressionOptions: { level: config.zipLevel },
          });
          compressedMediaCount += 1;
        }
      } catch {
        // Keep original file if image re-encoding fails
      }
    }
  }

  const buffer = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: {
      level: config.zipLevel,
    },
  });

  return { buffer, compressedMediaCount };
}

export async function compressAsZip(
  files: Array<{ name: string; data: ArrayBuffer | Uint8Array }>,
  configInput: CompressionConfigInput
): Promise<Uint8Array> {
  const config = resolveConfig(configInput);
  const zip = new JSZip();
  const usedNames = new Map<string, number>();

  for (const item of files) {
    let targetName = item.name;
    const count = usedNames.get(targetName) ?? 0;
    if (count > 0) {
      const ext = getFileExtension(item.name);
      const base = ext
        ? item.name.slice(0, -(ext.length + 1))
        : item.name;
      targetName = ext ? `${base} (${count}).${ext}` : `${base} (${count})`;
    }
    usedNames.set(item.name, count + 1);

    zip.file(targetName, item.data, {
      compression: 'DEFLATE',
      compressionOptions: { level: config.zipLevel },
    });
  }

  return zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: {
      level: config.zipLevel,
    },
  });
}

export async function compressPdfBytes(
  data: Uint8Array,
  configInput: CompressionConfigInput = 'balanced',
  compressPdfImage?: EmbeddedPdfImageCompressor
): Promise<{ buffer: Uint8Array; compressedImagesCount: number }> {
  const config = resolveConfig(configInput);
  const pdfDoc = await PDFDocument.load(data, {
    ignoreEncryption: true,
    updateMetadata: false,
  });

  if (pdfDoc.isEncrypted) {
    throw new Error('Encrypted PDFs are preserved unmodified');
  }

  let compressedImagesCount = 0;

  if (config.targetReductionPercent >= 70) {
    const catalog = pdfDoc.catalog;
    if (catalog.has(PDFName.of('Metadata'))) {
      catalog.delete(PDFName.of('Metadata'));
    }
    pdfDoc.setTitle('');
    pdfDoc.setAuthor('');
    pdfDoc.setSubject('');
    pdfDoc.setKeywords([]);
    pdfDoc.setProducer('');
    pdfDoc.setCreator('');
  }

  if (compressPdfImage) {
    const objects = pdfDoc.context.enumerateIndirectObjects();
      for (const [ref, obj] of objects) {
        if (!(obj instanceof PDFRawStream)) continue;
        const dict = obj.dict;
        const subtype = dict.get(PDFName.of('Subtype'));
        if (subtype !== PDFName.of('Image')) continue;

        const filter = dict.get(PDFName.of('Filter'));
        if (filter !== PDFName.of('DCTDecode')) continue;

        const rawBytes = obj.contents;
        if (rawBytes.byteLength < 2048) continue;

        try {
          const optimized = await compressPdfImage(rawBytes, 'jpg', config);
          if (optimized && optimized.bytes.byteLength < rawBytes.byteLength) {
            const newDict = dict.clone(pdfDoc.context);
            newDict.set(
              PDFName.of('Length'),
              PDFNumber.of(optimized.bytes.byteLength)
            );
            if (optimized.width && optimized.height) {
              newDict.set(PDFName.of('Width'), PDFNumber.of(optimized.width));
              newDict.set(PDFName.of('Height'), PDFNumber.of(optimized.height));
            }
            pdfDoc.context.assign(
              ref,
              PDFRawStream.of(newDict, optimized.bytes)
            );
            compressedImagesCount += 1;
          }
        } catch {
          // Leave embedded image untouched on decode error
        }
      }
    }

  const buffer = await pdfDoc.save({
    useObjectStreams: true,
    addDefaultPage: false,
  });

  return { buffer, compressedImagesCount };
}
