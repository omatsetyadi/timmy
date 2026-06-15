import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractImagePaths, attachImages } from './image-attach'

describe('extractImagePaths', () => {
  it('finds an absolute image path in a message', () => {
    expect(extractImagePaths('can you check /Users/me/Downloads/x.jpeg ?')).toEqual([
      '/Users/me/Downloads/x.jpeg',
    ])
  })
  it('finds multiple, of supported extensions', () => {
    expect(extractImagePaths('see /a/b.png and /c/d.JPG')).toEqual(['/a/b.png', '/c/d.JPG'])
  })
  it('ignores non-image paths and prose', () => {
    expect(extractImagePaths('no image; /etc/hosts and report.txt')).toEqual([])
  })
})

describe('attachImages', () => {
  it('reads existing images as data URLs, skips missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'img-'))
    const p = join(dir, 'pic.png')
    writeFileSync(p, Buffer.from([1, 2, 3]))
    const urls = await attachImages(`look at ${p} and /nope/missing.png`)
    expect(urls).toHaveLength(1)
    expect(urls[0]).toMatch(/^data:image\/png;base64,/)
  })
})
