import { defaultFileStore } from '@/lib/files/server-store';
import { getPool } from '@/lib/db/pools';
import { attachDriverBlPhoto, BL_PHOTO_MAX_BYTES } from '@/modules/field';
import { fieldJson, fieldRoute } from '../context';

// @permission driver session: the photo of the signed BL for one of the driver's own rotations (checked, metadata stripped, sealed)
export async function POST(request: Request): Promise<Response> {
  return fieldRoute(request, { write: true, session: true }, async ({ user }) => {
    if (!user || user.role !== 'driver') return fieldJson(403, { error: 'FORBIDDEN' });
    // Refuse a huge body before reading it.
    const declared = Number(request.headers.get('content-length') ?? '0');
    if (declared > BL_PHOTO_MAX_BYTES + 4096) return fieldJson(413, { error: 'TOO_LARGE' });
    const form = await request.formData().catch(() => null);
    const file = form?.get('photo');
    if (!form || !(file instanceof File)) return fieldJson(400, { error: 'INVALID' });
    const result = await attachDriverBlPhoto(
      getPool('app'),
      user,
      { tripId: form.get('tripId'), key: form.get('key'), takenAt: form.get('takenAt') },
      { declaredType: file.type, bytes: new Uint8Array(await file.arrayBuffer()) },
      { store: defaultFileStore() },
    );
    if (result.ok) return fieldJson(200, { status: result.value.status });
    // Refusals the phone must not retry (the photo is dropped from its queue): they are all 4xx.
    return fieldJson(result.error === 'NOT_YOUR_ROTATION' ? 403 : result.error === 'TOO_LARGE' ? 413 : 422, {
      error: result.error,
    });
  });
}
