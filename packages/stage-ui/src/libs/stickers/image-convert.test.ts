import { describe, expect, it } from 'vitest'

import { applyAlphaMask } from './image-convert'

describe('applyAlphaMask', () => {
  function makeFakeImageData(width: number, height: number, initialAlpha = 255): ImageData {
    const data = new Uint8ClampedArray(width * height * 4)
    for (let i = 0; i < width * height; i++) {
      data[i * 4] = 100
      data[i * 4 + 1] = 150
      data[i * 4 + 2] = 200
      data[i * 4 + 3] = initialAlpha
    }
    return { data, width, height } as unknown as ImageData
  }

  it('keeps pure background (0) fully transparent and solid foreground (255) fully opaque', () => {
    const source = makeFakeImageData(2, 1)
    const mask = new Uint8Array([0, 255])

    const result = applyAlphaMask(source, mask, 65)

    expect(result.data[3]).toBe(0) // first pixel alpha
    expect(result.data[7]).toBe(255) // second pixel alpha
  })

  it('cuts off values below the noise threshold for 65% sensitivity', () => {
    const source = makeFakeImageData(2, 1)
    // At s = 0.65, cutoff is ~0.0875 (22/255). Values <= 22 become 0.
    const mask = new Uint8Array([15, 22])

    const result = applyAlphaMask(source, mask, 65)

    expect(result.data[3]).toBe(0)
    expect(result.data[7]).toBe(0)
  })

  it('boosts intermediate edge values with 65% sensitivity (gamma < 1)', () => {
    const source = makeFakeImageData(1, 1)
    // Intermediate edge pixel with value 100 (~39% confidence)
    const mask = new Uint8Array([100])

    const result = applyAlphaMask(source, mask, 65)

    // With 65% sensitivity, gamma is ~0.687, boosting mid-range edge alpha
    expect(result.data[3]).toBeGreaterThan(100)
    expect(result.data[3]).toBeLessThan(255)
  })

  it('applies stricter threshold and crushes edges with 0% sensitivity', () => {
    const source = makeFakeImageData(2, 1)
    const mask = new Uint8Array([60, 100])

    const result = applyAlphaMask(source, mask, 0)

    // At 0% sensitivity, cutoff is 0.25 (63.75/255), so 60 becomes 0
    expect(result.data[3]).toBe(0)
    // 100 is crushed downwards by gamma ~3.5
    expect(result.data[7]).toBeLessThan(50)
  })

  it('preserves fine faint edges with 100% sensitivity', () => {
    const source = makeFakeImageData(1, 1)
    const mask = new Uint8Array([30])

    const result = applyAlphaMask(source, mask, 100)

    // At 100% sensitivity, cutoff is 0 and gamma is ~0.287, boosting faint pixels
    expect(result.data[3]).toBeGreaterThan(100)
  })

  it('spreads compressed mid-tone masks so washed-out background gets cut', () => {
    // Regression test for "capturing too much": a model that scores
    // background ~0.3 and foreground ~0.7 must not keep the background at
    // clean (0%) sensitivity after anchored normalization.
    const source = makeFakeImageData(4, 1)
    const mask = new Uint8Array([76, 100, 140, 180]) // ~0.30 - ~0.71

    const result = applyAlphaMask(source, mask, 0)

    // Anchored range is [0.08, 0.85]; cutoff at 0% is 0.45.
    // 76 -> norm ~0.28 -> cut to 0; the top end stays the strongest.
    expect(result.data[3]).toBe(0)
    expect(result.data[15]).toBeGreaterThan(result.data[11])
    expect(result.data[11]).toBeGreaterThanOrEqual(result.data[7])
    // Normalization spread the range instead of keeping the wash.
    expect(result.data[15] - result.data[3]).toBeGreaterThan(30)
  })

  it('produces graduated alpha across an edge ramp instead of binary steps', () => {
    // Anti-aliased edges need a smooth ramp, not a hard on/off cliff.
    const source = makeFakeImageData(5, 1)
    const mask = new Uint8Array([0, 64, 128, 192, 255])

    const result = applyAlphaMask(source, mask, 65)
    const alphas = [0, 1, 2, 3, 4].map(i => result.data[i * 4 + 3])

    expect(alphas[0]).toBe(0)
    expect(alphas[4]).toBe(255)
    for (let i = 1; i < alphas.length; i++)
      expect(alphas[i]).toBeGreaterThanOrEqual(alphas[i - 1]!)
    expect(new Set(alphas).size).toBeGreaterThan(2)
  })

  it('handles a flat uncertain mask without NaN or full-opacity blowout', () => {
    const source = makeFakeImageData(2, 2)
    const mask = new Uint8Array([128, 128, 128, 128])

    const result = applyAlphaMask(source, mask, 65)

    for (let i = 0; i < 4; i++) {
      expect(Number.isFinite(result.data[i * 4 + 3])).toBe(true)
      // Anchored ceiling keeps a uniformly weak mask translucent, never opaque.
      expect(result.data[i * 4 + 3]).toBeLessThan(255)
    }
  })
})
