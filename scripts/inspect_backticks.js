const fs = require('fs');
const p = 'c:/Users/Ins/Desktop/VSCode workspace/blockchain-dashboard/scripts/update_pool_volume_indexer.js';
const s = fs.readFileSync(p, 'utf8');
const lines = s.split(/\r?\n/);
let total=0;
lines.forEach((l,i)=>{ const c=(l.match(/`/g)||[]).length; if(c>0) console.log(`${i+1}: (${c}) ${l}`); total+=c; });
console.log('TOTAL backticks:', total);
