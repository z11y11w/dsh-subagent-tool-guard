// 列 asar 内目录（ELECTRON_RUN_AS_NODE=1 运行）
const fs = require('node:fs')
const path = require('node:path')

const target = process.argv[2]
const depth = Number(process.argv[3] || 2)

function walk(dir, d, prefix) {
  if (d > depth) return
  let items
  try {
    items = fs.readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    console.log(prefix + '<err> ' + e.message)
    return
  }
  for (const it of items.slice(0, 200)) {
    if (it.name === 'node_modules') continue
    let size = ''
    if (it.isFile()) {
      try { size = ' ' + fs.statSync(path.join(dir, it.name)).size } catch {}
    }
    console.log(prefix + it.name + (it.isDirectory() ? '/' : '') + size)
    if (it.isDirectory()) walk(path.join(dir, it.name), d + 1, prefix + it.name + '/')
  }
}

walk(target, 0, '')
