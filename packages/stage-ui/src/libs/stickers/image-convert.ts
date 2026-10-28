/**
 * DOM image conversion helpers for the sticker transparency flow.
 * Kept in a dedicated module (not the store) so unit tests can stub the
 * browser surface via `vi.mock`. No persistence here — blobs must never pass
 * through `JSON.stringify`; see airi-binary-safety.
 */

export async function blobToImageData(blob: Blob): Promise<ImageData> {
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')
    if (!ctx)
      throw new Error('2d canvas context unavailable')
    ctx.drawImage(bitmap, 0, 0)
    return ctx.getImageData(0, 0, canvas.width, canvas.height)
  }
  finally {
    bitmap.close?.()
  }
}

export async function imageDataToPngBlob(image: ImageData): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const ctx = canvas.getContext('2d')
  if (!ctx)
    throw new Error('2d canvas context unavailable')
  ctx.putImageData(image, 0, 0)
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
  if (!blob)
    throw new Error('canvas.toBlob produced no output')
  return blob
}

/**
 * Applies a grayscale mask to an ImageData's alpha channel with adjustable sensitivity.
 *
 * Pipeline per pixel: anchored normalization -> cutoff -> gamma curve.
 * - Anchored normalization spreads compressed masks (e.g. a model that scores
 *   background 0.3 and foreground 0.7) across the full range, so mid-tone
 *   background wash actually gets cut instead of kept. Anchors
 *   (floor 0.08, ceiling 0.85) mean well-formed masks pass through nearly
 *   untouched and uniformly weak masks are never promoted to foreground.
 * - Higher sensitivity (> 50%): lower cutoff + gamma < 1 boosts weak/soft
 *   edges and hair strands toward full opacity.
 * - Lower sensitivity (< 50%): higher cutoff (up to 0.45) + gamma > 1 crushes
 *   lingering background halos and blocky low-confidence regions.
 *
 * @param source Source RGBA ImageData.
 * @param maskData Grayscale mask buffer (0-255 per pixel).
 * @param sensitivity Sensitivity percentage (0 to 100, default 65).
 */
export function applyAlphaMask(
  source: ImageData,
  maskData: Uint8Array,
  sensitivity = 65,
): ImageData {
  const output = typeof ImageData !== 'undefined'
    ? new ImageData(new Uint8ClampedArray(source.data), source.width, source.height)
    : { data: new Uint8ClampedArray(source.data), width: source.width, height: source.height } as ImageData

  const s = Math.max(0, Math.min(100, sensitivity)) / 100

  // Robust 1st/99th percentile of the mask histogram: ignores outlier specks
  // when measuring the mask's true dynamic range. O(n) via 256-bin histogram.
  let lo = 0
  let hi = 255
  if (maskData.length > 0) {
    const hist = new Uint32Array(256)
    for (let i = 0; i < maskData.length; i++)
      hist[maskData[i]!]++
    let acc = 0
    for (let b = 0; b < 256; b++) {
      acc += hist[b]!
      if (acc / maskData.length > 0.01) {
        lo = b
        break
      }
    }
    acc = 0
    for (let b = 255; b >= 0; b--) {
      acc += hist[b]!
      if (acc / maskData.length > 0.01) {
        hi = b
        break
      }
    }
  }
  // Anchored normalization: stretch compressed masks, never promote weak ones.
  const loN = Math.min(lo / 255, 0.08)
  const hiN = Math.max(hi / 255, 0.85)
  const span = Math.max(hiN - loN, 1e-6)

  const cutoff = (1 - s) * 0.45

  // Gamma curve: s > 0.5 -> gamma < 1 (boosts edges), s < 0.5 -> gamma > 1 (crushes edges)
  const gamma = 2 ** ((1 - 2 * s) * 1.8)

  const len = maskData.length
  for (let i = 0; i < len; i++) {
    const norm = Math.min(1, Math.max(0, (maskData[i]! / 255 - loN) / span))
    if (norm <= cutoff) {
      output.data[4 * i + 3] = 0
    }
    else {
      const adjusted = ((norm - cutoff) / (1 - cutoff)) ** gamma
      output.data[4 * i + 3] = Math.round(Math.min(255, Math.max(0, adjusted * 255)))
    }
  }

  return output
}
