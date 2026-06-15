import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { mimeFromPath } from '../reasoning/vision'

/** Absolute file path ending in an image extension. */
const IMAGE_PATH = /(\/[^\s'"]+\.(?:png|jpe?g|webp|gif))/gi

/** Pure: extract candidate image file paths referenced in a message (absolute paths ending in
 *  an image extension). Existence is NOT checked here. */
export function extractImagePaths(message: string): string[] {
  return [...message.matchAll(IMAGE_PATH)].map((m) => m[1])
}

/** Read the existing image paths referenced in a message as data URLs, for inline attachment
 *  to a vision-capable model. Missing files are skipped. */
export async function attachImages(message: string): Promise<string[]> {
  const out: string[] = []
  for (const path of extractImagePaths(message)) {
    if (!existsSync(path)) continue
    const buf = await readFile(path)
    out.push(`data:${mimeFromPath(path)};base64,${buf.toString('base64')}`)
  }
  return out
}
