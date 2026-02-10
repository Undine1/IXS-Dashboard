const fs = require('fs');
const p = 'c:/Users/Ins/Desktop/VSCode workspace/blockchain-dashboard/scripts/update_pool_volume_indexer.js';
let s = fs.readFileSync(p, 'utf8');
let lines = s.split(/\r?\n/);
// remove lines that are exactly ``` or ```javascript
lines = lines.filter(l => l.trim() !== '```' && l.trim() !== '```javascript');
// ensure only one shebang at top
lines = lines.filter((l, i) => !(l.trim() === '#!/usr/bin/env node' && i !== 0));
// if first line is not shebang, insert it
if (lines.length === 0 || lines[0].trim() !== '#!/usr/bin/env node') {
  lines.unshift('#!/usr/bin/env node');
}
fs.writeFileSync(p, lines.join('\n'), 'utf8');
console.log('fixed update script — wrote', lines.length, 'lines');
