import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import {
  buildOutputFileName,
  calculateSavings,
  detectFileCategory,
  formatBytes,
  getConfigFromStrength,
  getFileExtension,
  minifyTextContent,
  minifyXmlContent,
  summarizeBatch,
} from './format';
import {
  compressAsZip,
  compressOfficePackage,
  compressPdfBytes,
} from './office-zip';

test('getFileExtension extracts lowercase extensions accurately', () => {
  assert.equal(getFileExtension('report.DOCX'), 'docx');
  assert.equal(getFileExtension('deck.final.pptx'), 'pptx');
  assert.equal(getFileExtension('photo.jpeg'), 'jpeg');
  assert.equal(getFileExtension('README'), '');
  assert.equal(getFileExtension('.gitignore'), '');
});

test('detectFileCategory maps docx, pptx, images, video, audio, pdf, and general files', () => {
  assert.equal(detectFileCategory('proposal.docx'), 'document');
  assert.equal(detectFileCategory('slides.pptx'), 'presentation');
  assert.equal(detectFileCategory('photo.png'), 'image');
  assert.equal(detectFileCategory('clip.mp4'), 'video');
  assert.equal(detectFileCategory('track.mp3'), 'audio');
  assert.equal(detectFileCategory('brochure.pdf'), 'pdf');
  assert.equal(detectFileCategory('vector.svg'), 'text');
  assert.equal(detectFileCategory('dataset.bin'), 'other');
});

test('formatBytes renders clean human-readable sizes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.50 KB');
  assert.equal(formatBytes(2.5 * 1024 * 1024), '2.50 MB');
});

test('calculateSavings computes positive savings and guards invalid sizes', () => {
  assert.deepEqual(calculateSavings(1000, 250), {
    savedBytes: 750,
    savedPercent: 75,
  });
  assert.deepEqual(calculateSavings(1000, 1200), {
    savedBytes: 0,
    savedPercent: 0,
  });
  assert.deepEqual(calculateSavings(0, 0), {
    savedBytes: 0,
    savedPercent: 0,
  });
});

test('buildOutputFileName preserves base name and applies target extension', () => {
  assert.equal(
    buildOutputFileName('quarterly.deck.pptx', 'pptx'),
    'quarterly.deck-compressed.pptx'
  );
  assert.equal(
    buildOutputFileName('notes', 'zip'),
    'notes-compressed.zip'
  );
});

test('minifyTextContent compacts JSON and SVG cleanly', () => {
  const json = '{\n  "name": "test",\n  "items": [1, 2, 3]\n}';
  assert.equal(
    minifyTextContent(json, 'json'),
    '{"name":"test","items":[1,2,3]}'
  );

  const svg = '<svg>  <!-- comment -->  <rect width="10" height="10" />  </svg>';
  assert.equal(
    minifyTextContent(svg, 'svg'),
    '<svg><rect width="10" height="10" /></svg>'
  );
});

test('minifyXmlContent strips inter-tag whitespace and comments without touching text runs', () => {
  const xml =
    '<w:document>\n  <!-- meta -->\n  <w:p>\n    <w:t>Keep   inner spacing</w:t>\n  </w:p>\n</w:document>';
  assert.equal(
    minifyXmlContent(xml),
    '<w:document><w:p><w:t>Keep   inner spacing</w:t></w:p></w:document>'
  );
});

test('summarizeBatch aggregates only completed files cleanly', () => {
  const summary = summarizeBatch([
    { originalSize: 1000, compressedSize: 400, status: 'done' },
    { originalSize: 2000, compressedSize: 600, status: 'done' },
    { originalSize: 5000, compressedSize: null, status: 'compressing' },
    { originalSize: 300, compressedSize: null, status: 'error' },
  ]);

  assert.equal(summary.totalFiles, 4);
  assert.equal(summary.completedFiles, 2);
  assert.equal(summary.processingFiles, 1);
  assert.equal(summary.errorFiles, 1);
  assert.equal(summary.totalOriginal, 3000);
  assert.equal(summary.totalCompressed, 1000);
  assert.equal(summary.totalSavedBytes, 2000);
  assert.equal(summary.totalSavedPercent, 66.7);
});

test('compressOfficePackage shrinks DOCX, strips thumbnails, minifies XML, and compresses media', async () => {
  const zip = new JSZip();
  const largeXml =
    '<w:document>\n  <!-- comment -->\n' +
    '  <w:p><w:t>Hello world</w:t></w:p>\n'.repeat(200) +
    '</w:document>';
  const fakePng = new Uint8Array(1000).fill(7);
  zip.file('word/document.xml', largeXml, { compression: 'STORE' });
  zip.file('word/media/image1.png', fakePng, { compression: 'STORE' });
  zip.file('docProps/thumbnail.jpeg', new Uint8Array(2000).fill(3), {
    compression: 'STORE',
  });

  const rawDocx = await zip.generateAsync({
    type: 'uint8array',
    compression: 'STORE',
  });

  const { buffer, compressedMediaCount, minifiedXmlCount } =
    await compressOfficePackage(rawDocx, 'maximum', async (bytes) =>
      bytes.slice(0, 200)
    );

  assert.equal(compressedMediaCount, 1);
  assert.equal(minifiedXmlCount, 1);
  assert.ok(buffer.byteLength < rawDocx.byteLength);

  const reopened = await JSZip.loadAsync(buffer);
  const media = await reopened.file('word/media/image1.png')?.async('uint8array');
  assert.equal(media?.byteLength, 200);
  assert.equal(reopened.file('docProps/thumbnail.jpeg'), null);
});

test('compressAsZip compresses repetitive general files significantly', async () => {
  const payload = new TextEncoder().encode('repeat-line-content-'.repeat(400));
  const zipped = await compressAsZip(
    [{ name: 'data.txt', data: payload }],
    'maximum'
  );
  assert.ok(zipped.byteLength < payload.byteLength * 0.25);
});

test('compressPdfBytes re-saves a valid PDF document and strips metadata at strong presets', async () => {
  const doc = await PDFDocument.create();
  doc.setTitle('Verbose Sample Document Title');
  doc.setAuthor('Sample Author');
  const page = doc.addPage([400, 400]);
  page.drawText('Sample PDF content for compression test', { x: 40, y: 300 });
  const rawPdf = await doc.save({ useObjectStreams: false });
  const { buffer } = await compressPdfBytes(rawPdf, 'maximum');
  assert.ok(buffer.byteLength > 0);

  const reopened = await PDFDocument.load(buffer);
  assert.equal(reopened.getTitle(), '');
});

test('getConfigFromStrength maps presets and custom slider strengths accurately', () => {
  assert.equal(getConfigFromStrength(35).level, 'light');
  assert.equal(getConfigFromStrength(70).level, 'balanced');
  assert.equal(getConfigFromStrength(95).level, 'maximum');

  const custom = getConfigFromStrength(55);
  assert.equal(custom.targetReductionPercent, 55);
  assert.ok(custom.imageQuality < 0.85 && custom.imageQuality > 0.50);
  assert.ok(custom.zipLevel >= 6 && custom.zipLevel <= 9);
});

test('validateFileSize enforces non-empty and 25 MB limits', async () => {
  const { validateFileSize } = await import('./format');
  assert.equal(validateFileSize(0).valid, false);
  assert.equal(validateFileSize(1024).valid, true);
  assert.equal(validateFileSize(25 * 1024 * 1024).valid, true);
  assert.equal(validateFileSize(25 * 1024 * 1024 + 1).valid, false);
});

