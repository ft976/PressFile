import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  buildOutputFileName,
  detectFileCategory,
  getConfigFromStrength,
  getFileExtension,
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
import type { CompressionPresetConfig, OutputMode } from './types';

const execFileAsync = promisify(execFile);

function sanitizeExtension(ext: string): string {
  const clean = ext.toLowerCase().replace(/[^a-z0-9]/g, '');
  return clean.slice(0, 10);
}

interface ProbeInfo {
  durationSec: number;
  overallBitrate: number;
  videoBitrate: number;
  videoWidth: number;
  videoHeight: number;
  hasAudio: boolean;
  audioBitrate: number;
}

async function probeMedia(filePath: string): Promise<ProbeInfo> {
  const defaults: ProbeInfo = {
    durationSec: 0,
    overallBitrate: 0,
    videoBitrate: 0,
    videoWidth: 0,
    videoHeight: 0,
    hasAudio: false,
    audioBitrate: 0,
  };

  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v',
        'quiet',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        filePath,
      ],
      { timeout: 15000, maxBuffer: 2 * 1024 * 1024 }
    );
    const parsed = JSON.parse(stdout) as {
      format?: { duration?: string; bit_rate?: string };
      streams?: Array<{
        codec_type?: string;
        bit_rate?: string;
        width?: number;
        height?: number;
      }>;
    };

    const durationSec = Number(parsed.format?.duration ?? 0) || 0;
    const overallBitrate = Number(parsed.format?.bit_rate ?? 0) || 0;
    let videoBitrate = 0;
    let videoWidth = 0;
    let videoHeight = 0;
    let hasAudio = false;
    let audioBitrate = 0;

    for (const stream of parsed.streams ?? []) {
      if (stream.codec_type === 'video' && videoWidth === 0) {
        videoWidth = Number(stream.width ?? 0) || 0;
        videoHeight = Number(stream.height ?? 0) || 0;
        videoBitrate = Number(stream.bit_rate ?? 0) || 0;
      } else if (stream.codec_type === 'audio') {
        hasAudio = true;
        audioBitrate = Number(stream.bit_rate ?? 0) || 0;
      }
    }

    return {
      durationSec,
      overallBitrate,
      videoBitrate,
      videoWidth,
      videoHeight,
      hasAudio,
      audioBitrate,
    };
  } catch {
    return defaults;
  }
}

async function compressImageWithImageMagick(
  bytes: Uint8Array,
  ext: string,
  config: CompressionPresetConfig,
  tmpDir: string,
  allowOpaquePngToJpeg: boolean
): Promise<CompressedImageResult | null> {
  const safeExt = sanitizeExtension(ext) || 'jpg';
  const inputPath = path.join(tmpDir, `in-${Math.random().toString(36).slice(2)}.${safeExt}`);
  const outputPath = path.join(tmpDir, `out-${Math.random().toString(36).slice(2)}.${safeExt}`);

  await fs.writeFile(inputPath, bytes);
  try {
    const quality = Math.round(config.imageQuality * 100);
    const maxDim = `${config.maxDimension}x${config.maxDimension}>`;

    if (safeExt === 'png') {
      const colors =
        config.targetReductionPercent >= 85
          ? 64
          : config.targetReductionPercent >= 65
            ? 128
            : 256;

      await execFileAsync(
        'convert',
        [
          inputPath,
          '-strip',
          '-resize',
          maxDim,
          '-colors',
          String(colors),
          '-define',
          'png:compression-level=9',
          outputPath,
        ],
        { timeout: 25000 }
      );

      let bestBytes = new Uint8Array(await fs.readFile(outputPath));
      let convertedExt: string | undefined;

      if (allowOpaquePngToJpeg && config.targetReductionPercent >= 50) {
        try {
          const { stdout } = await execFileAsync(
            'identify',
            ['-format', '%[opaque]', inputPath],
            { timeout: 10000 }
          );
          if (stdout.trim().toLowerCase() === 'true') {
            const jpgPath = outputPath.replace(/\.png$/, '.jpg');
            await execFileAsync(
              'convert',
              [
                inputPath,
                '-strip',
                '-background',
                'white',
                '-flatten',
                '-sampling-factor',
                '4:2:0',
                '-resize',
                maxDim,
                '-quality',
                String(quality),
                jpgPath,
              ],
              { timeout: 25000 }
            );
            const jpgBytes = new Uint8Array(await fs.readFile(jpgPath));
            if (jpgBytes.byteLength < bestBytes.byteLength * 0.65) {
              bestBytes = jpgBytes;
              convertedExt = 'jpg';
            }
            await fs.unlink(jpgPath).catch(() => {});
          }
        } catch {
          // Keep PNG if opacity check or JPEG conversion fails
        }
      }

      if (bestBytes.byteLength < bytes.byteLength) {
        try {
          const { stdout } = await execFileAsync(
            'identify',
            ['-format', '%w %h', convertedExt ? inputPath : outputPath],
            { timeout: 10000 }
          );
          const [wStr, hStr] = stdout.trim().split(' ');
          return {
            bytes: bestBytes,
            width: Number(wStr) || undefined,
            height: Number(hStr) || undefined,
            convertedExtension: convertedExt,
          };
        } catch {
          return {
            bytes: bestBytes,
            convertedExtension: convertedExt,
          };
        }
      }
      return null;
    }

    if (safeExt === 'gif') {
      const colors = config.targetReductionPercent >= 75 ? 64 : 128;
      await execFileAsync(
        'convert',
        [
          inputPath,
          '-coalesce',
          '-resize',
          maxDim,
          '-colors',
          String(colors),
          '-layers',
          'Optimize',
          outputPath,
        ],
        { timeout: 30000 }
      );
    } else {
      const args = [inputPath, '-strip', '-resize', maxDim];
      if (safeExt === 'jpg' || safeExt === 'jpeg') {
        args.push(
          '-interlace',
          'Plane',
          '-sampling-factor',
          '4:2:0',
          '-quality',
          String(quality)
        );
      } else if (safeExt === 'webp') {
        args.push('-quality', String(quality));
      } else {
        args.push('-quality', String(quality));
      }
      args.push(outputPath);

      await execFileAsync('convert', args, { timeout: 25000 });
    }

    const outBytes = new Uint8Array(await fs.readFile(outputPath));
    if (outBytes.byteLength >= bytes.byteLength) {
      return null;
    }

    let width: number | undefined;
    let height: number | undefined;
    try {
      const { stdout } = await execFileAsync(
        'identify',
        ['-format', '%w %h', outputPath],
        { timeout: 10000 }
      );
      const [wStr, hStr] = stdout.trim().split(' ');
      width = Number(wStr) || undefined;
      height = Number(hStr) || undefined;
    } catch {
      // Optional dimensions
    }

    return { bytes: outBytes, width, height };
  } catch {
    return null;
  } finally {
    await fs.unlink(inputPath).catch(() => {});
    await fs.unlink(outputPath).catch(() => {});
  }
}

async function compressVideoWithFfmpeg(
  bytes: Uint8Array,
  ext: string,
  config: CompressionPresetConfig,
  tmpDir: string
): Promise<{ bytes: Uint8Array; outputExtension: string; note: string }> {
  const safeExt = sanitizeExtension(ext) || 'mp4';
  const inputPath = path.join(tmpDir, `video-in.${safeExt}`);
  const outExt = safeExt === 'webm' ? 'webm' : 'mp4';
  const outputPath = path.join(tmpDir, `video-out.${outExt}`);

  await fs.writeFile(inputPath, bytes);
  const probe = await probeMedia(inputPath);

  const t = (config.targetReductionPercent - 10) / 85; // 0..1
  const crf = Math.round(23 + t * 12); // 23..35
  const maxHeight =
    config.targetReductionPercent >= 80
      ? 480
      : config.targetReductionPercent >= 50
        ? 720
        : 1080;
  const targetRatio = 0.8 - t * 0.52; // 0.80 -> 0.28
  const origVideoKbps =
    probe.videoBitrate > 0
      ? Math.round(probe.videoBitrate / 1000)
      : probe.overallBitrate > 0
        ? Math.max(120, Math.round((probe.overallBitrate / 1000) * 0.85))
        : 0;
  const maxRateKbps =
    origVideoKbps > 0
      ? Math.max(80, Math.round(origVideoKbps * targetRatio))
      : 0;
  const audioKbps =
    config.targetReductionPercent >= 80
      ? 64
      : config.targetReductionPercent >= 50
        ? 96
        : 128;

  const scaleFilter =
    probe.videoHeight > maxHeight
      ? `scale=-2:${maxHeight}`
      : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';

  const runEncode = async (
    passCrf: number,
    passMaxRateKbps: number,
    passAudioKbps: number,
    passFilter: string
  ) => {
    const args = ['-y', '-i', inputPath, '-vf', passFilter];

    if (outExt === 'webm') {
      args.push(
        '-c:v',
        'libvpx',
        '-crf',
        String(Math.min(45, passCrf + 4)),
        '-b:v',
        passMaxRateKbps > 0 ? `${passMaxRateKbps}k` : '500k'
      );
      if (probe.hasAudio) {
        args.push('-c:a', 'libvorbis', '-b:a', `${passAudioKbps}k`);
      }
    } else {
      args.push(
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        String(passCrf),
        '-pix_fmt',
        'yuv420p'
      );
      if (passMaxRateKbps > 0) {
        args.push(
          '-maxrate',
          `${passMaxRateKbps}k`,
          '-bufsize',
          `${passMaxRateKbps * 2}k`
        );
      }
      if (probe.hasAudio) {
        args.push('-c:a', 'aac', '-b:a', `${passAudioKbps}k`);
      }
      args.push('-movflags', '+faststart');
    }

    args.push(outputPath);
    await execFileAsync('ffmpeg', args, { timeout: 120000 });
    return new Uint8Array(await fs.readFile(outputPath));
  };

  let outBytes = await runEncode(crf, maxRateKbps, audioKbps, scaleFilter);

  // If first pass didn't shrink enough or exceeded input size, run tighter bitrate pass
  if (outBytes.byteLength >= bytes.byteLength) {
    const fallbackKbps =
      origVideoKbps > 0
        ? Math.max(45, Math.round(origVideoKbps * 0.45))
        : 220;
    const tighterHeight = Math.min(maxHeight, 480);
    const tighterFilter =
      probe.videoHeight > tighterHeight
        ? `scale=-2:${tighterHeight}`
        : scaleFilter;
    outBytes = await runEncode(
      Math.min(40, crf + 5),
      fallbackKbps,
      48,
      tighterFilter
    );
  }

  if (outBytes.byteLength < bytes.byteLength) {
    return {
      bytes: outBytes,
      outputExtension: outExt,
      note: 'Video & audio re-encoded',
    };
  }

  return {
    bytes,
    outputExtension: safeExt,
    note: 'Already optimized',
  };
}

async function compressAudioWithFfmpeg(
  bytes: Uint8Array,
  ext: string,
  config: CompressionPresetConfig,
  tmpDir: string
): Promise<{ bytes: Uint8Array; outputExtension: string; note: string }> {
  const safeExt = sanitizeExtension(ext) || 'mp3';
  const inputPath = path.join(tmpDir, `audio-in.${safeExt}`);
  await fs.writeFile(inputPath, bytes);
  const probe = await probeMedia(inputPath);

  const t = (config.targetReductionPercent - 10) / 85; // 0..1
  const ratio = 0.78 - t * 0.52; // 0.78 -> 0.26
  const ceilingKbps =
    config.targetReductionPercent >= 80
      ? 64
      : config.targetReductionPercent >= 50
        ? 112
        : 192;
  const origKbps =
    probe.audioBitrate > 0
      ? Math.round(probe.audioBitrate / 1000)
      : probe.overallBitrate > 0
        ? Math.round(probe.overallBitrate / 1000)
        : 192;

  const targetKbps = Math.max(
    24,
    Math.min(ceilingKbps, Math.round(origKbps * ratio))
  );

  let outExt = safeExt;
  const outputPath = (targetExt: string) =>
    path.join(tmpDir, `audio-out.${targetExt}`);

  const args = ['-y', '-i', inputPath, '-vn'];
  if (config.targetReductionPercent >= 50) {
    args.push('-map_metadata', '-1');
  }

  if (safeExt === 'mp3') {
    args.push('-c:a', 'libmp3lame', '-b:a', `${targetKbps}k`);
    if (targetKbps <= 64) {
      args.push('-ac', '1');
    }
  } else if (safeExt === 'm4a' || safeExt === 'aac') {
    args.push('-c:a', 'aac', '-b:a', `${targetKbps}k`);
    if (targetKbps <= 64) {
      args.push('-ac', '1');
    }
  } else if (safeExt === 'ogg' || safeExt === 'opus') {
    args.push('-c:a', 'libvorbis', '-b:a', `${targetKbps}k`);
  } else if (safeExt === 'wav') {
    // IMA ADPCM keeps valid .wav container while shrinking PCM size ~75%
    args.push('-c:a', 'adpcm_ima_wav');
    if (config.targetReductionPercent >= 70) {
      args.push('-ar', '22050', '-ac', '1');
    }
  } else if (safeExt === 'flac') {
    args.push('-c:a', 'flac', '-compression_level', '12');
    if (config.targetReductionPercent >= 75) {
      args.push('-sample_fmt', 's16', '-ar', '32000');
    }
  } else {
    outExt = 'mp3';
    args.push('-c:a', 'libmp3lame', '-b:a', `${targetKbps}k`);
  }

  const finalOutPath = outputPath(outExt);
  args.push(finalOutPath);

  await execFileAsync('ffmpeg', args, { timeout: 60000 });
  const outBytes = new Uint8Array(await fs.readFile(finalOutPath));

  if (outBytes.byteLength < bytes.byteLength) {
    return {
      bytes: outBytes,
      outputExtension: outExt,
      note:
        safeExt === 'wav'
          ? 'WAV ADPCM compressed'
          : `Re-encoded to ${targetKbps} kbps`,
    };
  }

  return {
    bytes,
    outputExtension: safeExt,
    note: 'Already optimized',
  };
}

async function compressPdfOnServer(
  bytes: Uint8Array,
  config: CompressionPresetConfig,
  tmpDir: string
): Promise<{ bytes: Uint8Array; outputExtension: string; note: string }> {
  const candidates: Array<{ bytes: Uint8Array; note: string }> = [];

  // Candidate 1: Ghostscript pdfwrite + pdf-lib object stream packing
  const inPdf = path.join(tmpDir, 'pdf-in.pdf');
  const gsPdf = path.join(tmpDir, 'pdf-gs.pdf');
  await fs.writeFile(inPdf, bytes);

  const dpi =
    config.targetReductionPercent >= 80
      ? 72
      : config.targetReductionPercent >= 50
        ? 110
        : 180;
  const pdfSetting =
    config.targetReductionPercent >= 80
      ? '/screen'
      : config.targetReductionPercent >= 50
        ? '/ebook'
        : '/printer';

  try {
    await execFileAsync(
      'gs',
      [
        '-sDEVICE=pdfwrite',
        '-dCompatibilityLevel=1.4',
        `-dPDFSETTINGS=${pdfSetting}`,
        '-dNOPAUSE',
        '-dQUIET',
        '-dBATCH',
        '-dDetectDuplicateImages=true',
        '-dCompressFonts=true',
        '-dSubsetFonts=true',
        '-dDownsampleColorImages=true',
        '-dDownsampleGrayImages=true',
        '-dDownsampleMonoImages=true',
        `-dColorImageResolution=${dpi}`,
        `-dGrayImageResolution=${dpi}`,
        `-dMonoImageResolution=${dpi}`,
        `-sOutputFile=${gsPdf}`,
        inPdf,
      ],
      { timeout: 60000 }
    );
    const gsBytes = new Uint8Array(await fs.readFile(gsPdf));
    if (gsBytes.byteLength > 20) {
      candidates.push({
        bytes: gsBytes,
        note: `PDF resampled (${dpi} DPI)`,
      });
      try {
        const { buffer: gsPacked } = await compressPdfBytes(gsBytes, config);
        candidates.push({
          bytes: gsPacked,
          note: `PDF resampled (${dpi} DPI) & stream-packed`,
        });
      } catch {
        // Keep raw gsBytes candidate
      }
    }
  } catch {
    // Fallback to pdf-lib pipeline
  }

  // Candidate 2: Direct pdf-lib object stream packing + DCTDecode image compression
  try {
    const { buffer: libBytes, compressedImagesCount } = await compressPdfBytes(
      bytes,
      config,
      (imgBytes, imgExt, cfg) =>
        compressImageWithImageMagick(imgBytes, imgExt, cfg, tmpDir, false)
    );
    candidates.push({
      bytes: libBytes,
      note:
        compressedImagesCount > 0
          ? `${compressedImagesCount} PDF images & streams compressed`
          : 'PDF streams compressed',
    });
  } catch {
    // Ignore if encrypted/unreadable
  }

  let best: { bytes: Uint8Array; note: string } | null = null;
  for (const candidate of candidates) {
    if (
      candidate.bytes.byteLength < bytes.byteLength &&
      (!best || candidate.bytes.byteLength < best.bytes.byteLength)
    ) {
      best = candidate;
    }
  }

  if (best) {
    return {
      bytes: best.bytes,
      outputExtension: 'pdf',
      note: best.note,
    };
  }

  // Candidate 3: ZIP fallback if PDF is already heavily packed and DEFLATE shrinks it
  const zipped = await compressAsZip(
    [{ name: 'document.pdf', data: bytes }],
    config
  );
  if (zipped.byteLength < bytes.byteLength) {
    return {
      bytes: zipped,
      outputExtension: 'zip',
      note: 'Packed as ZIP',
    };
  }

  return {
    bytes,
    outputExtension: 'pdf',
    note: 'Already optimized',
  };
}

export interface ServerCompressResult {
  bytes: Uint8Array;
  outputName: string;
  outputExtension: string;
  mimeType: string;
  note: string;
}

function getMimeTypeForExtension(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'pdf':
      return 'application/pdf';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'mp4':
      return 'video/mp4';
    case 'webm':
      return 'video/webm';
    case 'mp3':
      return 'audio/mpeg';
    case 'wav':
      return 'audio/wav';
    case 'm4a':
      return 'audio/mp4';
    case 'ogg':
      return 'audio/ogg';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'zip':
      return 'application/zip';
    default:
      return 'application/octet-stream';
  }
}

export async function compressFileOnServer(
  fileName: string,
  fileMime: string,
  rawBytes: Uint8Array,
  strengthPercent: number,
  outputMode: OutputMode
): Promise<ServerCompressResult> {
  if (rawBytes.byteLength === 0) {
    throw new Error('File is empty');
  }

  const config = getConfigFromStrength(strengthPercent);
  const ext = getFileExtension(fileName);
  const category = detectFileCategory(fileName, fileMime);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pressfile-'));

  try {
    if (outputMode === 'zip') {
      const zipped = await compressAsZip(
        [{ name: fileName, data: rawBytes }],
        config
      );
      return {
        bytes: zipped,
        outputName: buildOutputFileName(fileName, 'zip'),
        outputExtension: 'zip',
        mimeType: 'application/zip',
        note: 'Compressed into ZIP',
      };
    }

    // 1. Office OpenXML / ODF (DOCX, PPTX, XLSX, ODT, ODP)
    if (isOfficeZipExtension(ext)) {
      const { buffer, compressedMediaCount, minifiedXmlCount } =
        await compressOfficePackage(rawBytes, config, (imgBytes, imgExt, cfg) =>
          compressImageWithImageMagick(imgBytes, imgExt, cfg, tmpDir, true)
        );
      if (buffer.byteLength < rawBytes.byteLength) {
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
          bytes: buffer,
          outputName: buildOutputFileName(fileName, ext),
          outputExtension: ext,
          mimeType: fileMime || getMimeTypeForExtension(ext),
          note: parts.length > 0 ? parts.join(' · ') : 'Document deflated',
        };
      }
      return {
        bytes: rawBytes,
        outputName: buildOutputFileName(fileName, ext),
        outputExtension: ext,
        mimeType: fileMime || getMimeTypeForExtension(ext),
        note: 'Already optimized',
      };
    }

    // 2. Video (MP4, MOV, MKV, WebM, AVI, M4V)
    if (category === 'video') {
      const result = await compressVideoWithFfmpeg(
        rawBytes,
        ext,
        config,
        tmpDir
      );
      return {
        bytes: result.bytes,
        outputName: buildOutputFileName(fileName, result.outputExtension),
        outputExtension: result.outputExtension,
        mimeType: getMimeTypeForExtension(result.outputExtension),
        note: result.note,
      };
    }

    // 3. Audio (MP3, WAV, M4A, AAC, OGG, FLAC)
    if (category === 'audio') {
      const result = await compressAudioWithFfmpeg(
        rawBytes,
        ext,
        config,
        tmpDir
      );
      return {
        bytes: result.bytes,
        outputName: buildOutputFileName(fileName, result.outputExtension),
        outputExtension: result.outputExtension,
        mimeType: getMimeTypeForExtension(result.outputExtension),
        note: result.note,
      };
    }

    // 4. PDF
    if (category === 'pdf') {
      const result = await compressPdfOnServer(rawBytes, config, tmpDir);
      return {
        bytes: result.bytes,
        outputName: buildOutputFileName(fileName, result.outputExtension),
        outputExtension: result.outputExtension,
        mimeType: getMimeTypeForExtension(result.outputExtension),
        note: result.note,
      };
    }

    // 5. Images (JPG, PNG, WebP, GIF, BMP, TIFF, AVIF)
    if (category === 'image') {
      const result = await compressImageWithImageMagick(
        rawBytes,
        ext || 'jpg',
        config,
        tmpDir,
        false
      );
      if (result && result.bytes.byteLength < rawBytes.byteLength) {
        const outExt = result.convertedExtension || ext || 'jpg';
        return {
          bytes: result.bytes,
          outputName: buildOutputFileName(fileName, outExt),
          outputExtension: outExt,
          mimeType: getMimeTypeForExtension(outExt),
          note: 'Image optimized',
        };
      }
      return {
        bytes: rawBytes,
        outputName: buildOutputFileName(fileName, ext || 'jpg'),
        outputExtension: ext || 'jpg',
        mimeType: fileMime || getMimeTypeForExtension(ext || 'jpg'),
        note: 'Already optimized',
      };
    }

    // 6. ZIP Archives
    if (ext === 'zip') {
      try {
        const { buffer, compressedMediaCount } = await recompressZipArchive(
          rawBytes,
          config,
          (imgBytes, imgExt, cfg) =>
            compressImageWithImageMagick(imgBytes, imgExt, cfg, tmpDir, false)
        );
        if (buffer.byteLength < rawBytes.byteLength) {
          return {
            bytes: buffer,
            outputName: buildOutputFileName(fileName, 'zip'),
            outputExtension: 'zip',
            mimeType: 'application/zip',
            note:
              compressedMediaCount > 0
                ? `${compressedMediaCount} images & archive recompressed`
                : 'Archive recompressed',
          };
        }
      } catch {
        // Keep original if encrypted
      }
      return {
        bytes: rawBytes,
        outputName: buildOutputFileName(fileName, 'zip'),
        outputExtension: 'zip',
        mimeType: 'application/zip',
        note: 'Already optimized',
      };
    }

    // 7. Text / SVG / JSON / Code
    if (category === 'text') {
      const text = Buffer.from(rawBytes).toString('utf8');
      const minified = minifyTextContent(text, ext);
      const minBytes = Buffer.from(minified, 'utf8');
      if ((rawBytes.byteLength - minBytes.byteLength) / rawBytes.byteLength >= 0.05) {
        return {
          bytes: minBytes,
          outputName: buildOutputFileName(fileName, ext || 'txt'),
          outputExtension: ext || 'txt',
          mimeType: fileMime || 'text/plain',
          note: ext === 'svg' ? 'SVG minified' : 'Compacted',
        };
      }
      const zipped = await compressAsZip(
        [{ name: fileName, data: rawBytes }],
        config
      );
      if (zipped.byteLength < rawBytes.byteLength) {
        return {
          bytes: zipped,
          outputName: buildOutputFileName(fileName, 'zip'),
          outputExtension: 'zip',
          mimeType: 'application/zip',
          note: 'Compressed into ZIP',
        };
      }
      return {
        bytes: rawBytes,
        outputName: buildOutputFileName(fileName, ext || 'txt'),
        outputExtension: ext || 'txt',
        mimeType: fileMime || 'text/plain',
        note: 'Already compact',
      };
    }

    // 8. Any Other File Format -> DEFLATE Level-9 ZIP
    const zipped = await compressAsZip(
      [{ name: fileName, data: rawBytes }],
      config
    );
    if (zipped.byteLength < rawBytes.byteLength) {
      return {
        bytes: zipped,
        outputName: buildOutputFileName(fileName, 'zip'),
        outputExtension: 'zip',
        mimeType: 'application/zip',
        note: 'Compressed into ZIP',
      };
    }

    return {
      bytes: rawBytes,
      outputName: buildOutputFileName(fileName, ext),
      outputExtension: ext,
      mimeType: fileMime || 'application/octet-stream',
      note: 'Already compact',
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
