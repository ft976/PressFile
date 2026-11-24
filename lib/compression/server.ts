import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { PDFDocument } from 'pdf-lib';
import {
  buildOutputFileName,
  detectFileCategory,
  getConfigFromStrength,
  getFileExtension,
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
import type { CompressionPresetConfig } from './types';

const execFileAsync = promisify(execFile);
const GS_FONTMAP_DIR = path.join(process.cwd(), 'lib', 'compression', 'gs');
const GS_FONTPATH =
  '/usr/share/fonts/truetype/liberation:/usr/share/fonts/truetype/dejavu';

function sanitizeExtension(ext: string): string {
  const clean = ext.toLowerCase().replace(/[^a-z0-9]/g, '');
  return clean.slice(0, 10);
}

interface ProbeInfo {
  duration: number;
  overallBitrate: number;
  videoBitrate: number;
  videoHeight: number;
  hasAudio: boolean;
  audioBitrate: number;
}

async function probeMedia(filePath: string): Promise<ProbeInfo> {
  const defaults: ProbeInfo = {
    duration: 0,
    overallBitrate: 0,
    videoBitrate: 0,
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
      { timeout: 6000, maxBuffer: 1024 * 1024 }
    );
    const parsed = JSON.parse(stdout) as {
      format?: { bit_rate?: string; duration?: string };
      streams?: Array<{
        codec_type?: string;
        bit_rate?: string;
        height?: number;
        duration?: string;
      }>;
    };

    const overallBitrate = Number(parsed.format?.bit_rate ?? 0) || 0;
    let duration = Number(parsed.format?.duration ?? 0) || 0;
    let videoBitrate = 0;
    let videoHeight = 0;
    let hasAudio = false;
    let audioBitrate = 0;

    for (const stream of parsed.streams ?? []) {
      if (duration <= 0 && stream.duration) {
        duration = Number(stream.duration) || 0;
      }
      if (stream.codec_type === 'video' && videoHeight === 0) {
        videoHeight = Number(stream.height ?? 0) || 0;
        videoBitrate = Number(stream.bit_rate ?? 0) || 0;
      } else if (stream.codec_type === 'audio') {
        hasAudio = true;
        audioBitrate = Number(stream.bit_rate ?? 0) || 0;
      }
    }

    return {
      duration,
      overallBitrate,
      videoBitrate,
      videoHeight,
      hasAudio,
      audioBitrate,
    };
  } catch {
    return defaults;
  }
}

function pickClosestCandidate<T extends { bytes: Uint8Array }>(
  candidates: T[],
  originalSize: number,
  targetBytes: number
): T | null {
  let best: T | null = null;
  let bestDist = Infinity;

  for (const c of candidates) {
    if (c.bytes.byteLength >= originalSize) continue;
    const dist = Math.abs(c.bytes.byteLength - targetBytes);
    if (
      !best ||
      dist < bestDist ||
      (dist === bestDist && c.bytes.byteLength < best.bytes.byteLength)
    ) {
      best = c;
      bestDist = dist;
    }
  }
  return best;
}

async function compressImageWithImageMagick(
  bytes: Uint8Array,
  ext: string,
  config: CompressionPresetConfig,
  tmpDir: string,
  options: {
    allowOpaquePngToJpeg: boolean;
    needDimensions: boolean;
    noInterlace?: boolean;
  }
): Promise<CompressedImageResult | null> {
  const safeExt = sanitizeExtension(ext) || 'jpg';
  const id = Math.random().toString(36).slice(2, 10);
  const inputPath = path.join(tmpDir, `in-${id}.${safeExt}`);
  const outputPath = path.join(tmpDir, `out-${id}.${safeExt}`);

  await fs.writeFile(inputPath, bytes);
  try {
    const strength = config.targetReductionPercent;
    const targetBytes = Math.max(
      128,
      Math.round(bytes.byteLength * (1 - strength / 100))
    );
    const toleranceBytes = Math.max(256, Math.round(bytes.byteLength * 0.02));
    const maxDim = `${config.maxDimension}x${config.maxDimension}>`;

    const encodeRaster = async (
      quality: number,
      targetExt: string = safeExt,
      scalePercent = 100,
      forceSubsample420 = strength > 30
    ): Promise<{ bytes: Uint8Array; ext: string } | null> => {
      const outFile =
        targetExt === safeExt
          ? outputPath
          : outputPath.replace(new RegExp(`\\.${safeExt}$`), `.${targetExt}`);
      const args = [inputPath, '-strip'];
      if (targetExt === 'jpg' || targetExt === 'jpeg') {
        args.push('-background', 'white', '-flatten');
      }
      if (scalePercent < 100) {
        args.push('-resize', `${scalePercent}%`);
      } else if (strength > 30) {
        args.push('-resize', maxDim);
      }
      if (targetExt === 'jpg' || targetExt === 'jpeg') {
        if (!options.noInterlace) {
          args.push('-interlace', 'Plane');
        }
        if (forceSubsample420) {
          args.push('-sampling-factor', '4:2:0');
        }
        args.push('-quality', String(quality));
      } else {
        args.push('-quality', String(quality));
      }
      args.push(outFile);
      await execFileAsync('convert', args, { timeout: 15000 });
      const buf = new Uint8Array(await fs.readFile(outFile));
      if (outFile !== outputPath) {
        await fs.unlink(outFile).catch(() => {});
      }
      return { bytes: buf, ext: targetExt };
    };

    if (safeExt === 'png') {
      const encodePngStep = async (
        colors: number | null,
        scalePercent = 100
      ): Promise<{ bytes: Uint8Array; convertedExtension?: string } | null> => {
        const args = [inputPath, '-strip'];
        if (scalePercent < 100) {
          args.push('-resize', `${scalePercent}%`);
        } else if (strength > 30) {
          args.push('-resize', maxDim);
        }
        if (colors !== null) {
          args.push('-colors', String(colors));
        }
        args.push('-define', 'png:compression-level=8', outputPath);
        await execFileAsync('convert', args, { timeout: 15000 });
        return { bytes: new Uint8Array(await fs.readFile(outputPath)) };
      };

      const colorLadder: Array<number | null> = [null, 256, 192, 128, 64, 32, 16];
      let idx =
        strength <= 15
          ? 0
          : strength <= 30
            ? 1
            : strength <= 45
              ? 2
              : strength <= 60
                ? 3
                : strength <= 75
                  ? 4
                  : strength <= 88
                    ? 5
                    : 6;

      const candidates: Array<{
        bytes: Uint8Array;
        colors?: number | null;
        convertedExtension?: string;
      }> = [];

      const firstRaw = await encodePngStep(colorLadder[idx]);
      const first = firstRaw ? { ...firstRaw, colors: colorLadder[idx] } : null;
      if (first) candidates.push(first);

      let losslessCandidate: {
        bytes: Uint8Array;
        colors?: number | null;
      } | null = colorLadder[idx] === null ? first : null;

      if (
        first &&
        Math.abs(first.bytes.byteLength - targetBytes) > toleranceBytes
      ) {
        if (first.bytes.byteLength > targetBytes && idx < colorLadder.length - 1) {
          const midIdx = Math.min(colorLadder.length - 1, idx + 2);
          const strongerRaw = await encodePngStep(colorLadder[midIdx]);
          const stronger = strongerRaw
            ? { ...strongerRaw, colors: colorLadder[midIdx] }
            : null;
          if (stronger) candidates.push(stronger);
          if (
            stronger &&
            stronger.bytes.byteLength > targetBytes + toleranceBytes &&
            midIdx < colorLadder.length - 1
          ) {
            const strongestRaw = await encodePngStep(
              colorLadder[colorLadder.length - 1]
            );
            const strongest = strongestRaw
              ? { ...strongestRaw, colors: colorLadder[colorLadder.length - 1] }
              : null;
            if (strongest) candidates.push(strongest);
          }
        } else if (first.bytes.byteLength < targetBytes && idx > 0) {
          const lighterRaw = await encodePngStep(colorLadder[0]);
          const lighter = lighterRaw
            ? { ...lighterRaw, colors: colorLadder[0] }
            : null;
          if (lighter) {
            candidates.push(lighter);
            losslessCandidate = lighter;
          }
        }
      }

      // Optional JPEG conversion for large opaque embedded Office images when needed to reach target
      const bestPngSoFar = pickClosestCandidate(
        candidates,
        bytes.byteLength,
        targetBytes
      );
      if (
        options.allowOpaquePngToJpeg &&
        bytes.byteLength > 49152 &&
        strength >= 35 &&
        (!bestPngSoFar || bestPngSoFar.bytes.byteLength > targetBytes * 1.15)
      ) {
        try {
          const { stdout } = await execFileAsync(
            'identify',
            ['-format', '%[opaque]', inputPath],
            { timeout: 5000 }
          );
          if (stdout.trim().toLowerCase() === 'true') {
            const jpgQ = Math.max(40, Math.min(94, Math.round(96 - strength * 0.55)));
            const jpgTry = await encodeRaster(jpgQ, 'jpg', 100, true);
            if (jpgTry) {
              candidates.push({
                bytes: jpgTry.bytes,
                convertedExtension: 'jpg',
              });
            }
          }
        } catch {
          // Keep PNG
        }
      }

      // Bridge the truecolor -> 8-bit palette cliff smoothly using proportional truecolor scaling
      const bestSoFar = pickClosestCandidate(
        candidates,
        bytes.byteLength,
        targetBytes
      );
      if (
        !bestSoFar ||
        Math.abs(bestSoFar.bytes.byteLength - targetBytes) >
          Math.max(toleranceBytes * 2, bytes.byteLength * 0.08)
      ) {
        const tooSmallWithPalette =
          bestSoFar &&
          !bestSoFar.convertedExtension &&
          bestSoFar.bytes.byteLength < targetBytes * 0.85;

        if (tooSmallWithPalette) {
          if (!losslessCandidate) {
            const raw = await encodePngStep(null);
            if (raw) {
              losslessCandidate = { ...raw, colors: null };
              candidates.push(losslessCandidate);
            }
          }
          if (
            losslessCandidate &&
            losslessCandidate.bytes.byteLength > targetBytes + toleranceBytes
          ) {
            let scalePct = Math.max(
              35,
              Math.min(
                94,
                Math.round(
                  Math.sqrt(targetBytes / losslessCandidate.bytes.byteLength) * 100
                )
              )
            );
            for (let pass = 0; pass < 3 && scalePct < 98; pass += 1) {
              const scaledRaw = await encodePngStep(null, scalePct);
              if (!scaledRaw) break;
              candidates.push({ ...scaledRaw, colors: null });
              if (
                Math.abs(scaledRaw.bytes.byteLength - targetBytes) <=
                Math.max(toleranceBytes * 2, bytes.byteLength * 0.04)
              ) {
                break;
              }
              const ratioPct = Math.round(
                scalePct * Math.sqrt(targetBytes / scaledRaw.bytes.byteLength)
              );
              const nextPct = Math.max(
                30,
                Math.min(
                  98,
                  scaledRaw.bytes.byteLength > targetBytes
                    ? Math.min(scalePct - 6, ratioPct)
                    : Math.max(scalePct + 3, ratioPct)
                )
              );
              if (nextPct === scalePct) break;
              scalePct = nextPct;
            }
          }
        } else if (
          bestSoFar &&
          !bestSoFar.convertedExtension &&
          bestSoFar.bytes.byteLength > targetBytes + toleranceBytes * 2
        ) {
          const scaleColors =
            bestSoFar.colors !== undefined
              ? bestSoFar.colors
              : colorLadder[Math.min(idx + 1, colorLadder.length - 1)];
          let scalePct = Math.max(
            30,
            Math.min(
              97,
              Math.round(
                Math.sqrt(targetBytes / bestSoFar.bytes.byteLength) * 100
              )
            )
          );
          for (let pass = 0; pass < 3 && scalePct < 98; pass += 1) {
            const scaledRaw = await encodePngStep(scaleColors, scalePct);
            if (!scaledRaw) break;
            candidates.push({ ...scaledRaw, colors: scaleColors });
            if (
              Math.abs(scaledRaw.bytes.byteLength - targetBytes) <=
              Math.max(toleranceBytes * 2, bytes.byteLength * 0.04)
            ) {
              break;
            }
            const ratioPct = Math.round(
              scalePct * Math.sqrt(targetBytes / scaledRaw.bytes.byteLength)
            );
            const nextPct = Math.max(
              25,
              Math.min(
                98,
                scaledRaw.bytes.byteLength > targetBytes
                  ? Math.min(scalePct - 5, ratioPct)
                  : Math.max(scalePct + 2, ratioPct)
              )
            );
            if (nextPct === scalePct) break;
            scalePct = nextPct;
          }
        }
      }

      const chosen = pickClosestCandidate(
        candidates,
        bytes.byteLength,
        targetBytes
      );
      return chosen
        ? {
            bytes: chosen.bytes,
            convertedExtension: chosen.convertedExtension,
          }
        : null;
    }

    if (safeExt === 'gif') {
      const colors =
        strength >= 80 ? 48 : strength >= 50 ? 128 : 256;
      const gifArgs = [
        inputPath,
        '-coalesce',
        '-resize',
        maxDim,
        '-colors',
        String(colors),
        '-layers',
        'Optimize',
        outputPath,
      ];
      await execFileAsync('convert', gifArgs, { timeout: 20000 });
      const outBytes = new Uint8Array(await fs.readFile(outputPath));
      return outBytes.byteLength < bytes.byteLength ? { bytes: outBytes } : null;
    }

    // Binary search over quality (6 fast steps) for JPG / JPEG / WebP / other rasters
    const candidates: Array<{ bytes: Uint8Array }> = [];
    let lo = 8;
    let hi = 99;
    let q = Math.max(lo, Math.min(hi, Math.round(98 - (strength / 95) * 74)));

    for (let step = 0; step < 6; step += 1) {
      const res = await encodeRaster(q);
      if (!res) break;
      candidates.push({ bytes: res.bytes });

      if (Math.abs(res.bytes.byteLength - targetBytes) <= toleranceBytes) {
        break;
      }
      if (res.bytes.byteLength > targetBytes) {
        hi = Math.max(lo, q - 1);
      } else {
        lo = Math.min(hi, q + 1);
      }
      if (lo > hi) break;
      q = Math.round((lo + hi) / 2);
    }

    let best = pickClosestCandidate(candidates, bytes.byteLength, targetBytes);
    if (
      strength >= 25 &&
      best &&
      best.bytes.byteLength > targetBytes * 1.12
    ) {
      const scalePct = Math.max(
        35,
        Math.min(
          94,
          Math.round(Math.sqrt(targetBytes / best.bytes.byteLength) * 100)
        )
      );
      if (scalePct < 95) {
        const scaled = await encodeRaster(
          Math.max(28, q),
          safeExt,
          scalePct,
          true
        );
        if (scaled) {
          candidates.push({ bytes: scaled.bytes });
          best = pickClosestCandidate(candidates, bytes.byteLength, targetBytes);
        }
      }
    }

    if (!best) {
      return null;
    }

    if (options.needDimensions) {
      try {
        await fs.writeFile(outputPath, best.bytes);
        const { stdout } = await execFileAsync(
          'identify',
          ['-format', '%w %h', outputPath],
          { timeout: 5000 }
        );
        const [wStr, hStr] = stdout.trim().split(' ');
        return {
          bytes: best.bytes,
          width: Number(wStr) || undefined,
          height: Number(hStr) || undefined,
        };
      } catch {
        // Optional dimensions
      }
    }

    return { bytes: best.bytes };
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

  const strength = config.targetReductionPercent;
  const targetRatio = Math.max(0.05, 1 - strength / 100);
  const targetBytes = Math.round(bytes.byteLength * targetRatio);

  const origTotalKbps =
    probe.overallBitrate > 0
      ? Math.round(probe.overallBitrate / 1000)
      : probe.duration > 0
        ? Math.round((bytes.byteLength * 8) / probe.duration / 1000)
        : 0;

  const targetTotalKbps =
    probe.duration > 0
      ? Math.max(48, Math.floor((targetBytes * 8) / probe.duration / 1000))
      : Math.max(64, Math.round(origTotalKbps * targetRatio));

  const audioKbps = probe.hasAudio
    ? Math.min(128, Math.max(24, Math.round(targetTotalKbps * 0.18)))
    : 0;
  const targetVideoKbps = Math.max(32, targetTotalKbps - audioKbps);

  const maxHeight =
    targetVideoKbps < 220
      ? 480
      : targetVideoKbps < 520 || strength >= 60
        ? 720
        : 1080;

  const scaleFilter =
    probe.videoHeight > maxHeight
      ? `scale=-2:${maxHeight}`
      : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';

  const args = ['-y', '-threads', '0', '-i', inputPath, '-vf', scaleFilter];

  if (outExt === 'webm') {
    args.push(
      '-c:v',
      'libvpx',
      '-deadline',
      'realtime',
      '-cpu-used',
      '5',
      '-b:v',
      `${targetVideoKbps}k`
    );
    if (probe.hasAudio) {
      args.push('-c:a', 'libvorbis', '-b:a', `${audioKbps}k`);
    }
  } else {
    args.push(
      '-c:v',
      'libx264',
      '-preset',
      'superfast',
      '-b:v',
      `${targetVideoKbps}k`,
      '-maxrate',
      `${Math.round(targetVideoKbps * 1.15)}k`,
      '-bufsize',
      `${targetVideoKbps * 2}k`,
      '-pix_fmt',
      'yuv420p'
    );
    if (probe.hasAudio) {
      args.push('-c:a', 'aac', '-b:a', `${audioKbps}k`);
    }
    args.push('-movflags', '+faststart');
  }

  args.push(outputPath);
  await execFileAsync('ffmpeg', args, { timeout: 60000 });
  const outBytes = new Uint8Array(await fs.readFile(outputPath));

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

  const strength = config.targetReductionPercent;
  const targetRatio = Math.max(0.08, 1 - strength / 100);
  const origKbps =
    probe.audioBitrate > 0
      ? Math.round(probe.audioBitrate / 1000)
      : probe.overallBitrate > 0
        ? Math.round(probe.overallBitrate / 1000)
        : probe.duration > 0
          ? Math.round((bytes.byteLength * 8) / probe.duration / 1000)
          : 192;

  const targetKbps = Math.max(
    24,
    Math.min(320, Math.round(origKbps * targetRatio))
  );

  let outExt = safeExt;
  const args = ['-y', '-threads', '0', '-i', inputPath, '-vn'];
  if (strength >= 40) {
    args.push('-map_metadata', '-1');
  }

  if (safeExt === 'mp3') {
    args.push('-c:a', 'libmp3lame', '-b:a', `${targetKbps}k`);
    if (targetKbps <= 48) {
      args.push('-ac', '1');
    }
  } else if (safeExt === 'm4a' || safeExt === 'aac') {
    args.push('-c:a', 'aac', '-b:a', `${targetKbps}k`);
    if (targetKbps <= 48) {
      args.push('-ac', '1');
    }
  } else if (safeExt === 'ogg' || safeExt === 'opus') {
    args.push('-c:a', 'libvorbis', '-b:a', `${targetKbps}k`);
  } else if (safeExt === 'wav') {
    args.push('-c:a', 'adpcm_ima_wav');
    if (strength >= 70) {
      args.push('-ar', '22050', '-ac', '1');
    }
  } else if (safeExt === 'flac') {
    args.push('-c:a', 'flac', '-compression_level', '8');
    if (strength >= 75) {
      args.push('-sample_fmt', 's16', '-ar', '32000');
    }
  } else {
    outExt = 'mp3';
    args.push('-c:a', 'libmp3lame', '-b:a', `${targetKbps}k`);
  }

  const finalOutPath = path.join(tmpDir, `audio-out.${outExt}`);
  args.push(finalOutPath);

  await execFileAsync('ffmpeg', args, { timeout: 30000 });
  const outBytes = new Uint8Array(await fs.readFile(finalOutPath));

  if (outBytes.byteLength < bytes.byteLength) {
    return {
      bytes: outBytes,
      outputExtension: outExt,
      note:
        safeExt === 'wav'
          ? 'WAV compressed'
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
  let origPageCount = 0;
  try {
    const origDoc = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
    });
    if (origDoc.isEncrypted) {
      return {
        bytes,
        outputExtension: 'pdf',
        note: 'Protected PDF preserved',
      };
    }
    origPageCount = origDoc.getPageCount();
  } catch {
    return {
      bytes,
      outputExtension: 'pdf',
      note: 'Original PDF preserved',
    };
  }

  const inPdf = path.join(tmpDir, 'pdf-in.pdf');
  await fs.writeFile(inPdf, bytes);

  const strength = config.targetReductionPercent;
  const targetBytes = Math.max(
    512,
    Math.round(bytes.byteLength * (1 - strength / 100))
  );

  const runGhostscript = async (
    dpi: number,
    jpegQ: number,
    tag: string,
    imageFilter: 'dct' | 'flate' = 'dct'
  ): Promise<{ bytes: Uint8Array; note: string } | null> => {
    const outPdf = path.join(tmpDir, `pdf-gs-${tag}.pdf`);
    const pdfSetting =
      dpi <= 105 ? '/screen' : dpi <= 170 ? '/ebook' : '/printer';
    try {
      const gsArgs: string[] = [];
      if (existsSync(path.join(GS_FONTMAP_DIR, 'Fontmap'))) {
        gsArgs.push(`-I${GS_FONTMAP_DIR}`);
      }
      gsArgs.push(
        `-sFONTPATH=${GS_FONTPATH}`,
        '-sDEVICE=pdfwrite',
        '-dCompatibilityLevel=1.4',
        `-dPDFSETTINGS=${pdfSetting}`,
        '-dNOPAUSE',
        '-dBATCH',
        '-dNumRenderingThreads=4',
        '-dDetectDuplicateImages=true',
        '-dCompressFonts=true',
        '-dSubsetFonts=true',
        '-dPassThroughJPEGImages=false',
        '-dAutoFilterColorImages=false',
        '-dAutoFilterGrayImages=false',
        imageFilter === 'flate'
          ? '-dColorImageFilter=/FlateEncode'
          : '-dColorImageFilter=/DCTEncode',
        imageFilter === 'flate'
          ? '-dGrayImageFilter=/FlateEncode'
          : '-dGrayImageFilter=/DCTEncode',
        `-dJPEGQ=${jpegQ}`,
        '-dDownsampleColorImages=true',
        '-dDownsampleGrayImages=true',
        '-dDownsampleMonoImages=true',
        '-dColorImageDownsampleThreshold=1.0',
        '-dGrayImageDownsampleThreshold=1.0',
        '-dMonoImageDownsampleThreshold=1.0',
        `-dColorImageResolution=${dpi}`,
        `-dGrayImageResolution=${dpi}`,
        `-dMonoImageResolution=${dpi}`,
        `-sOutputFile=${outPdf}`,
        inPdf
      );

      const { stdout, stderr } = await execFileAsync('gs', gsArgs, {
        timeout: 35000,
        maxBuffer: 4 * 1024 * 1024,
      });

      const gsLog = `${stdout}\n${stderr}`;
      if (
        gsLog.includes('**** Error') ||
        gsLog.includes('Error reading a content stream') ||
        gsLog.includes('Output may be incorrect') ||
        gsLog.includes('may be damaged')
      ) {
        return null;
      }

      const gsBytes = new Uint8Array(await fs.readFile(outPdf));
      if (gsBytes.byteLength > 20) {
        return { bytes: gsBytes, note: `PDF compressed (${dpi} DPI)` };
      }
    } catch {
      // Ignore gs failure
    }
    return null;
  };

  const t = (strength - 10) / 85; // 0..1
  const initDpi = Math.round(280 - t * 200); // 280 -> 80 DPI
  const initJpegQ = Math.round(95 - t * 53); // 95 -> 42

  const pdfLibPromise = (async (): Promise<{ bytes: Uint8Array; note: string } | null> => {
    try {
      const { buffer: libBytes, compressedImagesCount } = await compressPdfBytes(
        bytes,
        config,
        (imgBytes, imgExt, cfg) =>
          compressImageWithImageMagick(imgBytes, imgExt, cfg, tmpDir, {
            allowOpaquePngToJpeg: false,
            needDimensions: true,
            noInterlace: true,
          })
      );
      return {
        bytes: libBytes,
        note:
          compressedImagesCount > 0
            ? `${compressedImagesCount} PDF images & streams compressed`
            : 'PDF streams compressed',
      };
    } catch {
      return null;
    }
  })();

  const [gsInitial, libCandidate] = await Promise.all([
    runGhostscript(initDpi, initJpegQ, 'init', 'dct'),
    pdfLibPromise,
  ]);

  const rawCandidates: Array<{ bytes: Uint8Array; note: string }> = [];
  if (gsInitial) rawCandidates.push(gsInitial);
  if (libCandidate) rawCandidates.push(libCandidate);

  const validateCandidate = async (
    candidate: { bytes: Uint8Array; note: string }
  ): Promise<boolean> => {
    if (candidate.bytes.byteLength >= bytes.byteLength) return false;
    try {
      const outDoc = await PDFDocument.load(candidate.bytes, {
        updateMetadata: false,
      });
      if (origPageCount > 0 && outDoc.getPageCount() !== origPageCount) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  };

  const validCandidates: Array<{ bytes: Uint8Array; note: string }> = [];
  for (const c of rawCandidates) {
    if (await validateCandidate(c)) {
      validCandidates.push(c);
    }
  }

  const selectBestPdfCandidate = (
    list: Array<{ bytes: Uint8Array; note: string }>
  ) => {
    const meaningful = list.filter(
      (c) =>
        c.bytes.byteLength <= bytes.byteLength * 0.98 &&
        c.bytes.byteLength >= targetBytes * 0.55
    );
    return (
      pickClosestCandidate(meaningful, bytes.byteLength, targetBytes) ??
      pickClosestCandidate(list, bytes.byteLength, targetBytes)
    );
  };

  let best = selectBestPdfCandidate(validCandidates);

  // If DCT Ghostscript overshot targetBytes (common on Flate/PNG PDFs), binary-search lossless Flate DPI
  if (
    gsInitial &&
    gsInitial.bytes.byteLength < targetBytes * 0.72 &&
    (!best ||
      best.bytes.byteLength > bytes.byteLength * 0.98 ||
      Math.abs(best.bytes.byteLength - targetBytes) > bytes.byteLength * 0.1)
  ) {
    let loDpi = 36;
    let hiDpi = 300;
    let flateDpi = Math.max(
      loDpi,
      Math.min(
        hiDpi,
        Math.round(180 * Math.sqrt(targetBytes / bytes.byteLength))
      )
    );
    const pdfTolerance = Math.max(1024, Math.round(bytes.byteLength * 0.04));

    for (let step = 0; step < 4; step += 1) {
      const flateRes = await runGhostscript(
        flateDpi,
        95,
        `flate${step}`,
        'flate'
      );
      if (!flateRes) break;
      if (await validateCandidate(flateRes)) {
        validCandidates.push(flateRes);
        best = selectBestPdfCandidate(validCandidates);
      }
      if (Math.abs(flateRes.bytes.byteLength - targetBytes) <= pdfTolerance) {
        break;
      }
      if (flateRes.bytes.byteLength > targetBytes) {
        // Need lower DPI; if size barely changed (>= 97% orig), jump lower quickly
        hiDpi = Math.max(loDpi, flateDpi - 2);
        if (flateRes.bytes.byteLength >= bytes.byteLength * 0.97) {
          flateDpi = Math.max(loDpi, Math.round((loDpi + hiDpi) * 0.45));
        } else {
          flateDpi = Math.round((loDpi + hiDpi) / 2);
        }
      } else {
        loDpi = Math.min(hiDpi, flateDpi + 2);
        flateDpi = Math.round((loDpi + hiDpi) / 2);
      }
      if (loDpi > hiDpi) break;
    }
  }

  // If still off targetBytes by > 10%, run one corrective DCT Ghostscript pass
  if (
    !best ||
    Math.abs(best.bytes.byteLength - targetBytes) > bytes.byteLength * 0.1
  ) {
    const tooSmall = best && best.bytes.byteLength < targetBytes * 0.85;
    const retryDpi = tooSmall
      ? Math.min(300, initDpi + 80)
      : Math.max(60, initDpi - 50);
    const retryJpegQ = tooSmall
      ? Math.min(97, initJpegQ + 18)
      : Math.max(28, initJpegQ - 20);

    if (retryDpi !== initDpi || retryJpegQ !== initJpegQ) {
      const gsRetry = await runGhostscript(retryDpi, retryJpegQ, 'retry', 'dct');
      if (gsRetry && (await validateCandidate(gsRetry))) {
        validCandidates.push(gsRetry);
        best = selectBestPdfCandidate(validCandidates);
      }
    }
  }

  if (best) {
    return {
      bytes: best.bytes,
      outputExtension: 'pdf',
      note: best.note,
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
  strengthPercent: number
): Promise<ServerCompressResult> {
  const sizeCheck = validateFileSize(rawBytes.byteLength);
  if (!sizeCheck.valid) {
    throw new Error(sizeCheck.error || 'Invalid file size');
  }

  const config = getConfigFromStrength(strengthPercent);
  const ext = getFileExtension(fileName);
  const category = detectFileCategory(fileName, fileMime);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pressfile-'));

  try {
    // 1. Office OpenXML / ODF (DOCX, PPTX, XLSX, ODT, ODP)
    if (isOfficeZipExtension(ext)) {
      const { buffer, compressedMediaCount, minifiedXmlCount } =
        await compressOfficePackage(rawBytes, config, (imgBytes, imgExt, cfg) =>
          compressImageWithImageMagick(imgBytes, imgExt, cfg, tmpDir, {
            allowOpaquePngToJpeg: true,
            needDimensions: false,
          })
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
        { allowOpaquePngToJpeg: false, needDimensions: false }
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
            compressImageWithImageMagick(imgBytes, imgExt, cfg, tmpDir, {
              allowOpaquePngToJpeg: false,
              needDimensions: false,
            })
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
      if (minBytes.byteLength < rawBytes.byteLength) {
        return {
          bytes: minBytes,
          outputName: buildOutputFileName(fileName, ext || 'txt'),
          outputExtension: ext || 'txt',
          mimeType: fileMime || 'text/plain',
          note: ext === 'svg' ? 'SVG minified' : 'Compacted',
        };
      }
      if (['svg', 'json', 'xml', 'html', 'htm', 'css'].includes(ext)) {
        return {
          bytes: rawBytes,
          outputName: buildOutputFileName(fileName, ext),
          outputExtension: ext,
          mimeType: fileMime || 'text/plain',
          note: 'Already compact',
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
          note: 'Compressed',
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

    // 8. Any Other File Format
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
        note: 'Compressed',
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
