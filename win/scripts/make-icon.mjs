import pngToIco from 'png-to-ico'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = path.join(here, '..', 'build', 'icon.png')
const out = path.join(here, '..', 'build', 'icon.ico')
const buf = await pngToIco(src)
fs.writeFileSync(out, buf)
console.log(`icon.ico written: ${out} (${buf.length} bytes)`)
