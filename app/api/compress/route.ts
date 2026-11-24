import { NextRequest, NextResponse } from 'next/server';
import { validateFileSize } from '@/lib/compression/format';
import { compressFileOnServer } from '@/lib/compression/server';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: 'Missing file in request' },
        { status: 400 }
      );
    }

    const sizeCheck = validateFileSize(file.size);
    if (!sizeCheck.valid) {
      return NextResponse.json(
        { error: sizeCheck.error || 'Invalid file size' },
        { status: 413 }
      );
    }

    const rawStrength = Number(formData.get('strengthPercent') ?? 70);
    const strengthPercent = Number.isFinite(rawStrength)
      ? Math.max(10, Math.min(95, Math.round(rawStrength)))
      : 70;

    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await compressFileOnServer(
      file.name,
      file.type,
      bytes,
      strengthPercent
    );

    const responseBody = new Uint8Array(result.bytes.byteLength);
    responseBody.set(result.bytes);

    return new NextResponse(responseBody, {
      status: 200,
      headers: {
        'Content-Type': result.mimeType,
        'X-Output-Name': encodeURIComponent(result.outputName),
        'X-Output-Extension': encodeURIComponent(result.outputExtension),
        'X-Compression-Note': encodeURIComponent(result.note),
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Compression failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
