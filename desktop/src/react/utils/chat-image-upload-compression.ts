export const CHAT_IMAGE_UPLOAD_COMPRESSION_POLICY = Object.freeze({
  targetBase64Chars: 850 * 1024,
  maxWidth: 1568,
  maxHeight: 1568,
  initialQuality: 0.82,
  minQuality: 0.58,
  qualityStep: 0.08,
  dimensionStep: 0.85,
});

const COMPRESSIBLE_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

interface ChatImageUploadInput {
  file: Blob;
  name: string;
  base64Data: string;
  mimeType: string;
  policy?: Partial<typeof CHAT_IMAGE_UPLOAD_COMPRESSION_POLICY>;
}

interface ChatImageUploadPayload {
  name: string;
  base64Data: string;
  mimeType: string;
  compressed: boolean;
}

interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

function normalizeMimeType(mimeType: string): string {
  return String(mimeType || '').trim().toLowerCase();
}

function uploadNameForMimeType(name: string, mimeType: string): string {
  const ext = mimeType === 'image/jpeg' ? 'jpg' : mimeType.split('/')[1] || 'jpg';
  const base = String(name || 'image').replace(/\.[^./\\]+$/u, '') || 'image';
  return `${base}.${ext}`;
}

function readBlobAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('image read failed'));
    reader.onload = () => {
      const value = typeof reader.result === 'string' ? reader.result : '';
      const comma = value.indexOf(',');
      resolve(comma >= 0 ? value.slice(comma + 1) : value);
    };
    reader.readAsDataURL(blob);
  });
}

async function decodeImage(blob: Blob): Promise<DecodedImage> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      release: () => bitmap.close?.(),
    };
  }

  if (typeof Image === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new Error('image compression is not available in this environment');
  }

  const url = URL.createObjectURL(blob);
  return await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      resolve({
        source: image,
        width: image.naturalWidth || image.width,
        height: image.naturalHeight || image.height,
        release: () => URL.revokeObjectURL(url),
      });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('image decode failed'));
    };
    image.src = url;
  });
}

function fitWithinBounds(width: number, height: number, maxWidth: number, maxHeight: number) {
  let nextWidth = width;
  let nextHeight = height;
  if (nextWidth > maxWidth) {
    nextHeight = Math.round((nextHeight * maxWidth) / nextWidth);
    nextWidth = maxWidth;
  }
  if (nextHeight > maxHeight) {
    nextWidth = Math.round((nextWidth * maxHeight) / nextHeight);
    nextHeight = maxHeight;
  }
  return {
    width: Math.max(1, nextWidth),
    height: Math.max(1, nextHeight),
  };
}

function jpegQualitySteps(policy: typeof CHAT_IMAGE_UPLOAD_COMPRESSION_POLICY) {
  const steps: number[] = [];
  for (
    let quality = policy.initialQuality;
    quality >= policy.minQuality - Number.EPSILON;
    quality -= policy.qualityStep
  ) {
    steps.push(Number(quality.toFixed(2)));
  }
  if (!steps.includes(policy.minQuality)) steps.push(policy.minQuality);
  return steps;
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('image compression failed'));
        return;
      }
      resolve(blob);
    }, mimeType, quality);
  });
}

async function encodeJpeg(source: CanvasImageSource, width: number, height: number, quality: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('image compression canvas unavailable');
  context.drawImage(source, 0, 0, width, height);
  const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
  return {
    base64Data: await readBlobAsBase64(blob),
    mimeType: 'image/jpeg',
  };
}

export async function prepareChatImageUpload(input: ChatImageUploadInput): Promise<ChatImageUploadPayload> {
  const policy = { ...CHAT_IMAGE_UPLOAD_COMPRESSION_POLICY, ...(input.policy || {}) };
  const mimeType = normalizeMimeType(input.mimeType);
  if (input.base64Data.length <= policy.targetBase64Chars) {
    return {
      name: input.name,
      base64Data: input.base64Data,
      mimeType,
      compressed: false,
    };
  }
  if (!COMPRESSIBLE_IMAGE_MIME_TYPES.has(mimeType)) {
    throw new Error('image is too large for upload and cannot be compressed safely');
  }

  const decoded = await decodeImage(input.file);
  try {
    let { width, height } = fitWithinBounds(decoded.width, decoded.height, policy.maxWidth, policy.maxHeight);
    const qualities = jpegQualitySteps(policy);

    while (width >= 1 && height >= 1) {
      for (const quality of qualities) {
        const encoded = await encodeJpeg(decoded.source, width, height, quality);
        if (encoded.base64Data.length <= policy.targetBase64Chars) {
          return {
            name: uploadNameForMimeType(input.name, encoded.mimeType),
            base64Data: encoded.base64Data,
            mimeType: encoded.mimeType,
            compressed: true,
          };
        }
      }

      const nextWidth = Math.max(1, Math.floor(width * policy.dimensionStep));
      const nextHeight = Math.max(1, Math.floor(height * policy.dimensionStep));
      if (nextWidth === width && nextHeight === height) break;
      width = nextWidth;
      height = nextHeight;
    }
  } finally {
    decoded.release();
  }

  throw new Error('image is too large for upload after compression');
}
