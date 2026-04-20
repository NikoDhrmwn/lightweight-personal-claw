/**
 * LiteClaw — Vision Module
 * 
 * Native multimodal vision: images are passed inline as base64
 * in the message array. No separate tool call needed.
 * This module only handles image preprocessing (resize/compress).
 * 
 * Same pattern as OpenWebUI: the model sees images natively.
 * NO tool is registered — the model sees images directly in the
 * multimodal message content. Registering a dummy tool causes
 * the model to call it instead of actually looking at the image.
 */

import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('vision');

/**
 * Preprocess an image for the LLM.
 * - Resize to maxDimensionPx (default: 1024)
 * - Convert to JPEG for consistent base64
 * - Returns data URI string
 */
export async function preprocessImage(
  input: Buffer | string,
  maxDimension?: number
): Promise<string> {
  const config = getConfig();
  const maxPx = maxDimension ?? config.tools?.vision?.maxDimensionPx ?? 1024;

  try {
    // Try to use sharp for resizing
    const sharp = await import('sharp').then(m => m.default).catch(() => null);

    if (sharp && Buffer.isBuffer(input)) {
      const meta = await sharp(input).metadata();
      const width = meta.width ?? 0;
      const height = meta.height ?? 0;

      let processed = sharp(input);

      // Only resize if larger than max dimension
      if (width > maxPx || height > maxPx) {
        processed = processed.resize(maxPx, maxPx, { fit: 'inside', withoutEnlargement: true });
      }

      const buffer = await processed.jpeg({ quality: 85 }).toBuffer();
      return `data:image/jpeg;base64,${buffer.toString('base64')}`;
    }
  } catch (err: any) {
    log.warn({ error: err.message }, 'Sharp processing failed, using raw image');
  }

  // Fallback: if input is already a data URI, return as-is
  if (typeof input === 'string') {
    if (input.startsWith('data:')) return input;
    // Assume raw base64
    return `data:image/jpeg;base64,${input}`;
  }

  // Buffer fallback: return as base64 without resizing
  return `data:image/jpeg;base64,${input.toString('base64')}`;
}

/**
 * Check if a message contains image content.
 */
export function hasImageContent(content: any): boolean {
  if (Array.isArray(content)) {
    return content.some(part => part.type === 'image_url');
  }
  return false;
}
