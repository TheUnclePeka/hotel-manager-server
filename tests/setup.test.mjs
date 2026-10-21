import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import http from 'node:http';
test('setup is local, requires its random URL, and rejects cross-origin changes',{timeout:15000},async()=>{
  const child=spawn(process.execPath,['scripts/setup.mjs','--no-open'],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  try {
    const address=await new Promise((resolve,reject)=>{
      let output='';const timer=setTimeout(()=>reject(new Error('Wizard startup timeout')),10000);
      child.once('error',e=>{clearTimeout(timer);reject(e);});
      child.stdout.on('data',chunk=>{output+=chunk;const found=output.match(/http:\/\/127\.0\.0\.1:\d+\/setup\/[\w-]+/);if(found){clearTimeout(timer);resolve(found[0]);}});
    });
    const page=await fetch(address);assert.equal(page.status,200);assert.match(await page.text(),/Hotel Manager/);
    assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
    const spoofed=await new Promise((resolve,reject)=>http.get(address,{headers:{Host:'untrusted.example'}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject));
    assert.equal(spoofed,403);
    assert.equal((await fetch(new URL('/setup/wrong',address))).status,403);
    assert.equal((await fetch(address+'/create',{method:'POST',headers:{Origin:'https://untrusted.example'}})).status,403);
  } finally {child.kill();}
});
