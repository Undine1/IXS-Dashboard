const fs = require('fs');
const p = 'c:/Users/Ins/Desktop/VSCode workspace/blockchain-dashboard/scripts/update_pool_volume_indexer.js';
let s = fs.readFileSync(p,'utf8');
let lines = s.split(/\r?\n/);
lines = lines.filter(l => !/^\s*```(?:javascript)?\s*$/.test(l));
fs.writeFileSync(p, lines.join('\n'), 'utf8');
console.log('cleaned fences, wrote', lines.length, 'lines');
