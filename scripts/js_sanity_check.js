const fs = require('fs');
const p = 'c:/Users/Ins/Desktop/VSCode workspace/blockchain-dashboard/scripts/update_pool_volume_indexer.js';
const s = fs.readFileSync(p,'utf8');
let line=1;
let col=0;
let inSingle=false, inDouble=false, inTemplate=false, inCommentLine=false, inCommentBlock=false, lastChar=null, escaped=false;
let brace=0, paren=0, bracket=0, backticks=0;
const events = [];
for(let i=0;i<s.length;i++){
  const ch=s[i];
  if(ch==='\n'){ line++; col=0; inCommentLine=false; }
  col++;
  if(inCommentLine){ lastChar=ch; continue; }
  if(inCommentBlock){ if(ch==='/' && lastChar==='*'){ inCommentBlock=false; } lastChar=ch; continue; }
  if(!inSingle && !inDouble && !inTemplate){
    if(ch==='/' && s[i+1]==='/'){ inCommentLine=true; lastChar=ch; continue; }
    if(ch==='/' && s[i+1]==='*'){ inCommentBlock=true; lastChar=ch; continue; }
  }
  if(!inTemplate && !inSingle && ch==='"' && !escaped){ inDouble=!inDouble; }
  else if(!inTemplate && !inDouble && ch==="'" && !escaped){ inSingle=!inSingle; }
  else if(!inSingle && !inDouble && ch==='`' && !escaped){ inTemplate=!inTemplate; backticks++; }
  if(!inSingle && !inDouble && !inTemplate){
    if(ch==='{') { brace++; events.push({type:'{', line, col, brace}); }
    if(ch==='}') { brace--; events.push({type:'}', line, col, brace}); }
    if(ch==='(') { paren++; }
    if(ch===')') { paren--; }
    if(ch==='[') { bracket++; }
    if(ch===']') { bracket--; }
  }
  if(ch==='\\' && !escaped) escaped=true; else escaped=false;
  lastChar=ch;
}
console.log('brace',brace,'paren',paren,'bracket',bracket,'backticks',backticks);
for(const e of events.slice(-40)){
  console.log(`${e.line}:${e.col} ${e.type} -> brace=${e.brace}`);
}
if(brace!==0 || paren!==0 || bracket!==0) process.exit(2); else process.exit(0);
