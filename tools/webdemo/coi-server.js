const http=require('http'),fs=require('fs'),path=require('path');
const root=process.argv[2], port=+process.argv[3];
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.wasm':'application/wasm',
  '.json':'application/json','.data':'application/octet-stream','.gz':'application/gzip','.cpio':'application/octet-stream'};
http.createServer((req,res)=>{
  let u=decodeURIComponent(req.url.split('?')[0]); if(u.endsWith('/'))u+='index.html';
  let f=path.join(root,u);
  fs.readFile(f,(e,buf)=>{
    if(e){res.writeHead(404);return res.end('404 '+u);}
    res.setHeader('Cross-Origin-Opener-Policy','same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
    res.setHeader('Cross-Origin-Resource-Policy','same-origin');
    res.setHeader('Content-Type',mime[path.extname(f)]||'application/octet-stream');
    res.writeHead(200);res.end(buf);
  });
}).listen(port,()=>console.log('serving '+root+' on '+port));
