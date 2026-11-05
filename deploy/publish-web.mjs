/**
 * Runs before the server starts. Copies this build's site into dist. With a
 * Dokploy volume on dist/assets, earlier builds' files stay too, so a page
 * opened just before an update can still load its code, such as the chunk that
 * builds a rip. Files no build has shipped for 30 days are removed.
 */
import { copyFile, cp, mkdir, readdir, rename, rm, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'

const FROM = 'web-build'
const TO = 'dist'
const MAX_AGE_MS = 30 * 86_400_000
const now = new Date()

await mkdir(join(TO, 'assets'), { recursive: true })

let added = 0
for (const name of await readdir(join(FROM, 'assets'))) {
  const target = join(TO, 'assets', name)
  // Already here from an earlier build: mark it as in use again.
  if (await utimes(target, now, now).then(() => true, () => false)) continue
  // Copy then rename, so a server reading the folder never sees half a file.
  const partial = `${target}.${process.pid}.tmp`
  await copyFile(join(FROM, 'assets', name), partial)
  await rename(partial, target)
  added += 1
}

let removed = 0
for (const name of await readdir(join(TO, 'assets'))) {
  const file = join(TO, 'assets', name)
  const age = now.getTime() - (await stat(file)).mtimeMs
  if (age > MAX_AGE_MS) {
    await rm(file, { force: true })
    removed += 1
  }
}

// Everything else, including index.html, belongs to this build.
for (const entry of await readdir(FROM, { withFileTypes: true })) {
  if (entry.name !== 'assets') await cp(join(FROM, entry.name), join(TO, entry.name), { recursive: true, force: true })
}

console.log(`web: ${added} files added, ${removed} older than 30 days removed`)
