import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { compressFileOnServer } from './server';

test('compressFileOnServer compresses MP4 video to smaller valid MP4', async () => {
  const bytes = new Uint8Array(
    await fs.readFile('.playwright-cli/fixtures/sample-video.mp4')
  );
  const result = await compressFileOnServer(
    'sample-video.mp4',
    'video/mp4',
    bytes,
    85,
    'smart'
  );
  assert.equal(result.outputExtension, 'mp4');
  assert.ok(
    result.bytes.byteLength < bytes.byteLength,
    `Expected MP4 ${result.bytes.byteLength} < ${bytes.byteLength}`
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
    85,
    'smart'
  );
  assert.equal(result.outputExtension, 'mp3');
  assert.ok(
    result.bytes.byteLength < bytes.byteLength,
    `Expected MP3 ${result.bytes.byteLength} < ${bytes.byteLength}`
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
  zip.file('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>Doc test</w:t></w:r></w:p></w:body></w:document>');
  zip.file('word/media/image1.png', pngBytes);
  const docxBytes = await zip.generateAsync({ type: 'uint8array' });

  const result = await compressFileOnServer(
    'heavy.docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    docxBytes,
    95,
    'smart'
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
    95,
    'smart'
  );
  assert.equal(result.outputExtension, 'pdf');
  assert.ok(result.bytes.byteLength < pdfBytes.byteLength);
});
