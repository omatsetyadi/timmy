import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { mimeFromPath } from '../reasoning/vision'

/** Absolute file path ending in an image extension. */
const IMAGE_PATH = /(\/[^\s'"]+\.(?:png|jpe?g|webp|gif))/gi

/** Cap an inline image so a stray/huge file can't blow up memory or the request body.
 *  (Matches typical vision-API limits; only paths the USER typed are ever read here.) */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** Pure: extract candidate image file paths referenced in a message (absolute paths ending in
 *  an image extension). Existence is NOT checked here. */
export function extractImagePaths(message: string): string[] {
  return [...message.matchAll(IMAGE_PATH)].map((m) => m[1])
}

/** Read the existing image paths referenced in a message as data URLs, for inline attachment
 *  to a vision-capable model. Missing or oversized files are skipped.
 *
 *  Security note: this only ever reads paths the USER typed in their OWN current message — it is
 *  NOT run over tool results or chat history, so there's no path-injection vector. Reading a
 *  user-named file is intentional (like attaching it). A home-dir restriction was considered and
 *  rejected: it breaks legit paths (external volumes) yet doesn't stop secrets under `~` (e.g.
 *  `~/.ssh/...`), so it's false security. The real guard is the size cap; for a cloud frontdesk
 *  the user typing a path is explicit consent to send it. */
export async function attachImages(message: string): Promise<string[]> {
  const out: string[] = []
  for (const path of extractImagePaths(message)) {
    if (!existsSync(path)) continue
    if (statSync(path).size > MAX_IMAGE_BYTES) continue // skip oversized files
    const buf = await readFile(path)
    out.push(`data:${mimeFromPath(path)};base64,${buf.toString('base64')}`)
  }
  return out
}
