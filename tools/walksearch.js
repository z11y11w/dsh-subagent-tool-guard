const fs = require('node:fs'); const path = require('node:path');
const root = process.argv[2];
const term = 'createScope';
const pkgs = fs.readdirSync(root).filter(n => n.startsWith('dsh-'));
for (const p of pkgs) {
  const srcRoot = path.join(root, p, 'src');
  if (!fs.existsSync(srcRoot)) continue;
  const walk = (dir) => {
    for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, it.name);
      if (it.isDirectory()) { walk(full); continue }
      if (!/\.(ts|js)$/.test(it.name)) continue;
      let text; try { text = fs.readFileSync(full, 'utf8') } catch { continue }
      if (!text.includes(term)) continue;
      text.split(/\r?\n/).forEach((line, i) => {
        if (line.includes(term)) console.log(p + '/' + path.relative(path.join(root, p), full) + ':' + (i + 1) + ': ' + line.trim().slice(0, 160));
      });
    }
  };
  walk(srcRoot);
}
