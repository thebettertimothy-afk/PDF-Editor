const C='pdfws-v2';
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(['./','./manifest.webmanifest'])).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{const r=e.request;
if(r.method==='POST'&&new URL(r.url).pathname.endsWith('/share')){e.respondWith((async()=>{const fd=await r.formData(),c=await caches.open('pdfws-share');let n=0;
for(const f of fd.getAll('pdf')){if(f instanceof File){await c.put('./shared/'+(n++),new Response(f,{headers:{'x-name':encodeURIComponent(f.name)}}))}}
return Response.redirect('./?shared='+n,303)})());return}
if(r.method!=='GET'||new URL(r.url).origin!==location.origin)return;
e.respondWith(caches.match(r,{ignoreSearch:r.mode==='navigate'}).then(m=>m||fetch(r).then(res=>{const cp=res.clone();caches.open(C).then(c=>c.put(r,cp));return res}).catch(()=>caches.match('./'))))});
