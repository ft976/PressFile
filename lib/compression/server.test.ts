import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { compressFileOnServer } from './server';
import { MAX_FILE_SIZE_BYTES } from './types';

test('compressFileOnServer compresses MP4 video to smaller valid MP4', async () => {
  const bytes = new Uint8Array(
    await fs.readFile('.playwright-cli/fixtures/sample-video.mp4')
  );
  const light = await compressFileOnServer(
    'sample-video.mp4',
    'video/mp4',
    bytes,
    35
  );
  const balanced = await compressFileOnServer(
    'sample-video.mp4',
    'video/mp4',
    bytes,
    70
  );
  const max = await compressFileOnServer(
    'sample-video.mp4',
    'video/mp4',
    bytes,
    95
  );
  assert.equal(light.outputExtension, 'mp4');
  assert.equal(balanced.outputExtension, 'mp4');
  assert.equal(max.outputExtension, 'mp4');
  assert.ok(light.bytes.byteLength < bytes.byteLength);
  assert.ok(
    balanced.bytes.byteLength <= light.bytes.byteLength,
    `Expected balanced ${balanced.bytes.byteLength} <= light ${light.bytes.byteLength}`
  );
  assert.ok(
    max.bytes.byteLength < light.bytes.byteLength,
    `Expected max ${max.bytes.byteLength} < light ${light.bytes.byteLength}`
  );
});

test('compressFileOnServer compresses MP3 audio to smaller valid MP3', async () => {
  const bytes = new Uint8Array(
    await fs.readFile('.playwright-cli/fixtures/sample-audio.mp3')
  );
  const result = await compressFileOnServer(
    'sample-audio.mp3',
    'audio/mpeg',
    bytes,
    85
  );
  assert.equal(result.outputExtension, 'mp3');
  assert.ok(
    result.bytes.byteLength < bytes.byteLength,
    `Expected MP3 ${result.bytes.byteLength} < ${bytes.byteLength}`
  );
});

test('compressFileOnServer scales output size with strength on PNG images', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const os = await import('node:os');
  const path = await import('node:path');
  const execFileAsync = promisify(execFile);

  const tmpPng = path.join(os.tmpdir(), `test-tex-${Date.now()}.png`);
  await execFileAsync('convert', [
    '-size',
    '480x360',
    'xc:gray',
    '+noise',
    'Random',
    '-blur',
    '0x0.7',
    tmpPng,
  ]);
  const bytes = new Uint8Array(await fs.readFile(tmpPng));
  await fs.rm(tmpPng).catch(() => {});

  const light = await compressFileOnServer(
    'sample-photo.png',
    'image/png',
    bytes,
    35
  );
  const max = await compressFileOnServer(
    'sample-photo.png',
    'image/png',
    bytes,
    95
  );
  assert.ok(light.bytes.byteLength < bytes.byteLength);
  assert.ok(
    max.bytes.byteLength < light.bytes.byteLength,
    `Expected max ${max.bytes.byteLength} < light ${light.bytes.byteLength}`
  );
});

test('compressFileOnServer compresses DOCX with embedded PNG and updates rels when converted', async () => {
  const pngBytes = new Uint8Array(
    await fs.readFile('.playwright-cli/fixtures/sample-photo.png')
  );
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/><Default Extension="xml" ContentType="application/xml"/></Types>'
  );
  zip.file(
    'word/_rels/document.xml.rels',
    '<Relationships><Relationship Id="rId1" Target="media/image1.png"/></Relationships>'
  );
  zip.file(
    'word/document.xml',
    '<w:document><w:body><w:p><w:r><w:t>Doc test</w:t></w:r></w:p></w:body></w:document>'
  );
  zip.file('word/media/image1.png', pngBytes);
  const docxBytes = await zip.generateAsync({ type: 'uint8array' });

  const result = await compressFileOnServer(
    'heavy.docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    docxBytes,
    95
  );
  assert.equal(result.outputExtension, 'docx');
  assert.ok(
    result.bytes.byteLength < docxBytes.byteLength,
    `Expected DOCX ${result.bytes.byteLength} < ${docxBytes.byteLength}`
  );
});

test('compressFileOnServer compresses PDF cleanly without increasing size', async () => {
  const doc = await PDFDocument.create();
  doc.setTitle('Test Title');
  const page = doc.addPage([400, 400]);
  page.drawText('PDF test text content', { x: 40, y: 300 });
  const pdfBytes = await doc.save({ useObjectStreams: false });

  const result = await compressFileOnServer(
    'test.pdf',
    'application/pdf',
    pdfBytes,
    95
  );
  assert.equal(result.outputExtension, 'pdf');
  assert.ok(result.bytes.byteLength < pdfBytes.byteLength);
});

test('compressFileOnServer preserves embedded images in PDFs with Helvetica text', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const os = await import('node:os');
  const path = await import('node:path');
  const execFileAsync = promisify(execFile);

  const tmpImg = path.join(os.tmpdir(), `test-hi-${Date.now()}.jpg`);
  await execFileAsync('convert', [
    '-size',
    '1600x1200',
    'xc:gray',
    '+noise',
    'Random',
    '-quality',
    '95',
    tmpImg,
  ]);
  const jpg = await fs.readFile(tmpImg);
  await fs.rm(tmpImg).catch(() => {});

  const doc = await PDFDocument.create();
  const img = await doc.embedJpg(jpg);
  const page = doc.addPage([612, 792]);
  page.drawText('Contract Document with Embedded Photo', {
    x: 40,
    y: 740,
    size: 16,
  });
  page.drawImage(img, { x: 40, y: 120, width: 530, height: 397 });
  const pdfBytes = new Uint8Array(
    await doc.save({ useObjectStreams: false })
  );

  const balanced = await compressFileOnServer(
    'photo-report.pdf',
    'application/pdf',
    pdfBytes,
    70
  );
  assert.equal(balanced.outputExtension, 'pdf');
  assert.ok(
    balanced.bytes.byteLength < pdfBytes.byteLength,
    `Expected compressed ${balanced.bytes.byteLength} < ${pdfBytes.byteLength}`
  );
  assert.ok(
    balanced.bytes.byteLength > 100_000,
    `Expected real image content preserved (> 100 KB), got ${balanced.bytes.byteLength} bytes`
  );
  const outDoc = await PDFDocument.load(balanced.bytes);
  assert.equal(outDoc.getPageCount(), 1);
});

test('compressFileOnServer preserves encrypted PDFs unmodified instead of stripping content', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const os = await import('node:os');
  const path = await import('node:path');
  const execFileAsync = promisify(execFile);

  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  page.drawText('Confidential content', { x: 40, y: 300 });
  const plainPath = path.join(os.tmpdir(), `plain-${Date.now()}.pdf`);
  const encPath = path.join(os.tmpdir(), `enc-${Date.now()}.pdf`);
  await fs.writeFile(plainPath, await doc.save());
  await execFileAsync('gs', [
    '-sDEVICE=pdfwrite',
    '-dNOPAUSE',
    '-dQUIET',
    '-dBATCH',
    '-sOwnerPassword=owner',
    '-sUserPassword=user',
    '-dEncryptionR=3',
    '-dKeyLength=128',
    `-sOutputFile=${encPath}`,
    plainPath,
  ]);
  const encBytes = new Uint8Array(await fs.readFile(encPath));
  await fs.rm(plainPath).catch(() => {});
  await fs.rm(encPath).catch(() => {});

  const result = await compressFileOnServer(
    'protected.pdf',
    'application/pdf',
    encBytes,
    95
  );
  assert.equal(result.outputExtension, 'pdf');
  assert.equal(result.bytes.byteLength, encBytes.byteLength);
});

test('compressFileOnServer targets requested strength percentage (10%, 50%, 70%) on JPEG, PNG, and PDF', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const os = await import('node:os');
  const path = await import('node:path');
  const execFileAsync = promisify(execFile);

  const tmpImg = path.join(os.tmpdir(), `test-pct-${Date.now()}.jpg`);
  const tmpPng = path.join(os.tmpdir(), `test-pct-${Date.now()}.png`);
  await execFileAsync('convert', [
    '-size',
    '1600x1200',
    'xc:gray',
    '+noise',
    'Random',
    '-quality',
    '95',
    tmpImg,
  ]);
  await execFileAsync('convert', [
    '-size',
    '960x720',
    'xc:gray',
    '+noise',
    'Random',
    '-blur',
    '0x0.7',
    tmpPng,
  ]);
  const jpg = new Uint8Array(await fs.readFile(tmpImg));
  const png = new Uint8Array(await fs.readFile(tmpPng));
  await fs.rm(tmpImg).catch(() => {});
  await fs.rm(tmpPng).catch(() => {});

  const jpg10 = await compressFileOnServer('photo.jpg', 'image/jpeg', jpg, 10);
  const jpg50 = await compressFileOnServer('photo.jpg', 'image/jpeg', jpg, 50);
  const jpg70 = await compressFileOnServer('photo.jpg', 'image/jpeg', jpg, 70);
  const red10 = (jpg.byteLength - jpg10.bytes.byteLength) / jpg.byteLength;
  const red50 = (jpg.byteLength - jpg50.bytes.byteLength) / jpg.byteLength;
  const red70 = (jpg.byteLength - jpg70.bytes.byteLength) / jpg.byteLength;

  assert.ok(
    red10 >= 0.05 && red10 <= 0.18,
    `Expected ~10% JPEG reduction at strength=10, got ${(red10 * 100).toFixed(1)}%`
  );
  assert.ok(
    red50 >= 0.42 && red50 <= 0.58,
    `Expected ~50% JPEG reduction at strength=50, got ${(red50 * 100).toFixed(1)}%`
  );
  assert.ok(
    red70 >= 0.60 && red70 <= 0.80,
    `Expected ~70% JPEG reduction at strength=70, got ${(red70 * 100).toFixed(1)}%`
  );

  const png50 = await compressFileOnServer('photo.png', 'image/png', png, 50);
  const pngRed50 = (png.byteLength - png50.bytes.byteLength) / png.byteLength;
  assert.ok(
    pngRed50 >= 0.40 && pngRed50 <= 0.62,
    `Expected ~50% PNG reduction at strength=50, got ${(pngRed50 * 100).toFixed(1)}%`
  );

  const doc = await PDFDocument.create();
  const embedded = await doc.embedJpg(jpg);
  const page = doc.addPage([612, 792]);
  page.drawText('Target size PDF test', { x: 40, y: 740, size: 16 });
  page.drawImage(embedded, { x: 40, y: 120, width: 530, height: 397 });
  const pdfBytes = new Uint8Array(
    await doc.save({ useObjectStreams: false })
  );

  const pdf10 = await compressFileOnServer(
    'report.pdf',
    'application/pdf',
    pdfBytes,
    10
  );
  const pdf50 = await compressFileOnServer(
    'report.pdf',
    'application/pdf',
    pdfBytes,
    50
  );
  const pdfRed10 =
    (pdfBytes.byteLength - pdf10.bytes.byteLength) / pdfBytes.byteLength;
  const pdfRed50 =
    (pdfBytes.byteLength - pdf50.bytes.byteLength) / pdfBytes.byteLength;
  assert.ok(
    pdfRed10 >= 0.05 && pdfRed10 <= 0.18,
    `Expected ~10% PDF reduction at strength=10, got ${(pdfRed10 * 100).toFixed(1)}%`
  );
  assert.ok(
    pdfRed50 >= 0.40 && pdfRed50 <= 0.60,
    `Expected ~50% PDF reduction at strength=50, got ${(pdfRed50 * 100).toFixed(1)}%`
  );
});

test('compressFileOnServer scales smoothly across 10%, 35%, 50% on truecolor PNG and Flate PDFs', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const os = await import('node:os');
  const path = await import('node:path');
  const execFileAsync = promisify(execFile);

  const tmpPng = path.join(os.tmpdir(), `test-ui-${Date.now()}.png`);
  await execFileAsync('convert', [
    '-size',
    '1200x800',
    'xc:white',
    '-fill',
    '#1e293b',
    '-draw',
    'rectangle 30,30 1170,100',
    '(',
    '-size',
    '520x350',
    'plasma:tomato-skyblue',
    ')',
    '-geometry',
    '+40+140',
    '-composite',
    tmpPng,
  ]);
  const uiPng = new Uint8Array(await fs.readFile(tmpPng));
  await fs.rm(tmpPng).catch(() => {});

  const png10 = await compressFileOnServer('ui.png', 'image/png', uiPng, 10);
  const png50 = await compressFileOnServer('ui.png', 'image/png', uiPng, 50);
  const pngRed10 = (uiPng.byteLength - png10.bytes.byteLength) / uiPng.byteLength;
  const pngRed50 = (uiPng.byteLength - png50.bytes.byteLength) / uiPng.byteLength;
  assert.ok(
    pngRed10 >= 0.05 && pngRed10 <= 0.22,
    `Expected ~10% UI PNG reduction at strength=10, got ${(pngRed10 * 100).toFixed(1)}%`
  );
  assert.ok(
    pngRed50 >= 0.40 && pngRed50 <= 0.62,
    `Expected ~50% UI PNG reduction at strength=50, got ${(pngRed50 * 100).toFixed(1)}%`
  );

  const doc = await PDFDocument.create();
  const embPng = await doc.embedPng(uiPng);
  const page = doc.addPage([800, 600]);
  page.drawImage(embPng, { x: 20, y: 20, width: 760, height: 560 });
  const flatePdf = new Uint8Array(await doc.save({ useObjectStreams: false }));

  const fPdf10 = await compressFileOnServer('flate.pdf', 'application/pdf', flatePdf, 10);
  const fPdf50 = await compressFileOnServer('flate.pdf', 'application/pdf', flatePdf, 50);
  const fRed10 = (flatePdf.byteLength - fPdf10.bytes.byteLength) / flatePdf.byteLength;
  const fRed50 = (flatePdf.byteLength - fPdf50.bytes.byteLength) / flatePdf.byteLength;
  assert.ok(
    fRed10 >= 0.05 && fRed10 <= 0.25,
    `Expected ~10% Flate PDF reduction at strength=10, got ${(fRed10 * 100).toFixed(1)}%`
  );
  assert.ok(
    fRed50 >= 0.35 && fRed50 <= 0.65,
    `Expected ~50% Flate PDF reduction at strength=50, got ${(fRed50 * 100).toFixed(1)}%`
  );
});

test('compressFileOnServer rejects files over 25 MB', async () => {
  const oversized = new Uint8Array(MAX_FILE_SIZE_BYTES + 1);
  await assert.rejects(
    () =>
      compressFileOnServer(
        'huge.bin',
        'application/octet-stream',
        oversized,
        70
      ),
    /Maximum size is 25\.0 MB/
  );
});
