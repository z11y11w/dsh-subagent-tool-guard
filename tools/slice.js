const fs = require('node:fs')
const f = process.env.TARGET
const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/)
const a = Number(process.argv[2]), b = Number(process.argv[3])
for (let i = a; i <= b && i <= lines.length; i++) console.log(i + ': ' + lines[i - 1])
