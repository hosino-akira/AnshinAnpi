import sharp from 'sharp';
import { fail } from './errors.js';

export const AVATAR_SIZE = 96;

// Work entirely in memory and strip source metadata; only the small JPEG survives.
export async function createAvatar(image, bounds) {
  let oriented, thumbnail;
  try {
    const { data, info } = await sharp(image, { limitInputPixels: 40_000_000 })
      .autoOrient().toBuffer({ resolveWithObject: true });
    oriented = data;
    const pipeline = sharp(oriented);
    if (bounds && ['Left', 'Top', 'Width', 'Height'].every(key => Number.isFinite(bounds[key]))
      && bounds.Width > 0 && bounds.Height > 0) {
      const side = Math.max(1, Math.min(info.width, info.height,
        Math.ceil(Math.max(bounds.Width * info.width, bounds.Height * info.height) * 1.5)));
      const left = Math.max(0, Math.min(info.width - side,
        Math.round((bounds.Left + bounds.Width / 2) * info.width - side / 2)));
      const top = Math.max(0, Math.min(info.height - side,
        Math.round((bounds.Top + bounds.Height / 2) * info.height - side / 2)));
      pipeline.extract({ left, top, width: side, height: side });
    }
    thumbnail = await pipeline.resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover' })
      .flatten({ background: '#ffffff' }).jpeg({ quality: 75 }).toBuffer();
    return thumbnail.toString('base64');
  } catch {
    fail(400, 'INVALID_FACE_IMAGE', '顔写真を読み取れません。もう一度撮影してください。');
  } finally {
    oriented?.fill(0);
    thumbnail?.fill(0);
  }
}
