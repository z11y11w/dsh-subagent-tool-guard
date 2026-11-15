// 在 asar 内递归搜索字面量：node search.js <dir> <term> [maxLines]
const fs = require('node:fs')
const path = require('node:path')

const dir = process.argv[2]
const term = process.argv[3]
const maxLines = Number(process.argv[4] || 20)
const MAX_BYTES = 2 * 1024 * 1024

function* walk(p, depth) {
  if (depth > 6) return
  let items
  try { items = fs.readdirSync(p, { withFileTypes: true }) } catch { return }
  for (const it of items) {
    if (it.name === 'node_modules' || it.name === '.git') continue
    const full = path.join(p, it.name)
    if (it.isDirectory()) yield* walk(full, depth + 1)
    else if (it.isFile() && /\.(js|ts|json|md|yml|yaml)$/.test(it.name)) yield full
  }
}

let printed = 0
for (const file of walk(dir, 0)) {
  let size = 0
  try { size = fs.statSync(file).size } catch { continue }
  if (size > MAX_BYTES) continue
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { continue }
  if (!text.includes(term)) continue
  const lines = text.split(/\r?\n/)
  const hits = []
  lines.forEach((line, i) => {
    if (line.includes(term)) hits.push(`${i + 1}: ${line.trim().slice(0, 200)}`)
  })
  if (hits.length === 0) continue
  console.log(`\n### ${file} (${hits.length} hits)`)
  for (const h of hits.slice(0, maxLines)) { console.log(h); printed++ }
  if (hits.length > maxLines) console.log(`... (${hits.length - maxLines} more)`)
}
console.log(`\n[total lines printed: ${printed}]`)
