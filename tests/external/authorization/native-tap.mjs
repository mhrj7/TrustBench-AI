// Observe the actual messages delivered to the unchanged Computer Controller.
import {spawn} from 'node:child_process';
import {appendFileSync} from 'node:fs';
const [binary,log]=process.argv.slice(2);
const child=spawn(binary,['mcp','computercontroller'],{env:process.env,stdio:['pipe','pipe','ignore']});
let buffer='';
process.stdin.on('data',chunk=>{
  buffer+=chunk;let n;
  while((n=buffer.indexOf('\n'))>=0){
    const line=buffer.slice(0,n);buffer=buffer.slice(n+1);
    try {const m=JSON.parse(line);if(m.method==='tools/call')appendFileSync(log,JSON.stringify({id:m.id,tool:m.params.name,arguments:m.params.arguments,at_ms:Date.now()})+'\n');}catch{}
    child.stdin.write(line+'\n');
  }
});
child.stdout.pipe(process.stdout);
process.stdin.on('end',()=>child.stdin.end());
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>{child.kill(sig);process.exit(0);});
child.on('exit',code=>process.exit(code??1));
