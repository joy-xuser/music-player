import http from 'node:http';
import {Readable} from 'node:stream';
import {readFile, stat, writeFile, mkdir, rename} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {timingSafeEqual, randomBytes, randomUUID} from 'node:crypto';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const PLATFORM_PORT=process.env.PORT||process.env.X_ZOHO_CATALYST_LISTEN_PORT;
const PORT=Number(PLATFORM_PORT||4173);
const HOST=process.env.HOST||(PLATFORM_PORT?'0.0.0.0':'127.0.0.1');
const DEFAULT_PLAYLIST='PLTSRCGR4a75c';
const ADMIN_PASSCODE=process.env.ADMIN_PASSCODE||'';
const LIBRARY_FILE=path.join(ROOT,'data','library.json');
const CATALYST_DATASTORE=process.env.CATALYST_DATASTORE==='1'||Boolean(process.env.X_ZOHO_CATALYST_LISTEN_PORT);
const CATALYST_LIBRARY_TABLE=process.env.CATALYST_LIBRARY_TABLE||'AagomoniLibrary';
const FALLBACK_HOSTS=['invidious.f5.si','inv.nadeko.net','invidious.flokinet.to','yewtu.be'];
const CONFIGURED_INSTANCE=(process.env.INVIDIOUS_INSTANCE||'').trim();
const cache=new Map(),hostCooldowns=new Map();
const adminSessions=new Map();
let catalystBootstrapPromise=null;
const INITIAL_CATEGORIES=[
  {id:'mahalaya',name:'Mahalaya'},
  {id:'shasthi',name:'Shasthi'},
  {id:'saptami',name:'Saptami'},
  {id:'ashtami',name:'Ashtami'},
  {id:'navami',name:'Navami'},
  {id:'dashami',name:'Dashami'}
];
let dynamicHosts=null,dynamicAt=0;

function configuredInstance(){
  if(!CONFIGURED_INSTANCE)return null;
  try{const u=new URL(CONFIGURED_INSTANCE),local=['localhost','127.0.0.1','::1'].includes(u.hostname);if((u.protocol==='https:'||local&&u.protocol==='http:')&&!u.username&&!u.password)return {host:u.host,base:u.origin};}catch{}
  console.warn('Ignoring invalid INVIDIOUS_INSTANCE; use HTTPS, or HTTP only for localhost.');return null;
}
async function hosts(){
  if(dynamicHosts&&Date.now()-dynamicAt<15*60_000)return dynamicHosts;
  let registered=[];try{const r=await fetch('https://api.invidious.io/instances.json?sort_by=api',{signal:AbortSignal.timeout(8000)});if(r.ok){const rows=await r.json();registered=rows.filter(([,d])=>d?.type==='https'&&d.api===true).map(([host])=>host);}}catch{}
  const publicHosts=[...new Set([...registered,...FALLBACK_HOSTS])].map(host=>({host,base:`https://${host}`}));
  dynamicHosts=[...new Map([configuredInstance(),...publicHosts].filter(Boolean).map(x=>[x.host,x])).values()];dynamicAt=Date.now();return dynamicHosts;
}
function routeKey(pathname){return pathname.startsWith('/api/v1/videos/')?'videos':'playlists'}
function coolHost(host,route='videos',permanent=false){const key=`${host}:${route}`,old=hostCooldowns.get(key)||{failures:0},failures=old.failures+1,wait=permanent?5*60_000:Math.min(3*60_000,15_000*2**Math.min(failures-1,3));hostCooldowns.set(key,{failures,until:Date.now()+wait});}
async function requestInstance(instance,pathname){
  const key=`${instance.host}:${routeKey(pathname)}`;
  try{const response=await fetch(`${instance.base}${pathname}`,{headers:{accept:'application/json'},signal:AbortSignal.timeout(10000)}),raw=await response.text();let data;try{data=JSON.parse(raw)}catch{throw new Error(`${instance.host} returned a non-JSON response (${response.status})`)}if(!response.ok||data?.error||data?.type==='error')throw new Error(`${instance.host}: ${data?.error||`HTTP ${response.status}`}`);hostCooldowns.delete(key);return {...instance,data};}
  catch(error){coolHost(instance.host,routeKey(pathname),/403|Endpoint disabled/i.test(error.message));throw new Error(`${instance.host}: ${error.message}`)}
}
async function invidious(pathname,excluded=[]){
  const all=await hosts(),skip=new Set(excluded),custom=configuredInstance();let pool=all.filter(x=>!skip.has(x.host)&&(!hostCooldowns.get(`${x.host}:${routeKey(pathname)}`)||hostCooldowns.get(`${x.host}:${routeKey(pathname)}`).until<=Date.now()));
  if(!pool.length)pool=all.filter(x=>!skip.has(x.host));
  if(custom&&!skip.has(custom.host)){const cd=hostCooldowns.get(`${custom.host}:${routeKey(pathname)}`);if(!cd||cd.until<=Date.now()){try{return await requestInstance(custom,pathname)}catch(error){console.warn(`Configured Invidious ${custom.host}: ${error.message}`)}}}
  const attempts=pool.filter(x=>x.host!==custom?.host).map(instance=>requestInstance(instance,pathname));
  try{return await Promise.any(attempts)}catch(e){const messages=e.errors?.map(x=>x.message)||[],details=messages.slice(0,4).join(' · '),token=messages.find(x=>/PO.?Token|Companion is starting|valid potoken/i.test(x));if(token)throw new Error(`${token} — Companion token is not ready; retry in about a minute. https://docs.invidious.io/youtube-errors-explained/#po-token-initialization-taking-too-much-time-to-complete`);throw new Error(`No Invidious instance could provide this request. ${details||'No instance responded.'}`)}
}
async function loadVideo(videoId,{fresh=false,exclude=[]}={}){
  const key=`video:${videoId}`;let result=!fresh&&!exclude.length?cache.get(key):null;
  if(result&&((hostCooldowns.get(`${result.instance}:videos`)?.until||0)>Date.now()))result=null;
  if(!result||Date.now()-result.time>90_000){const fetched=await invidious(`/api/v1/videos/${encodeURIComponent(videoId)}`,exclude);result={time:Date.now(),data:fetched.data,instance:fetched.host,base:fetched.base};if(!fresh&&!exclude.length)cache.set(key,result)}
  return result;
}
function audioFormats(result,videoId){
  const instanceOrigin=new URL(result.base).origin;
  return (result.data.adaptiveFormats||[]).filter(f=>{
    const type=String(f.type||'').toLowerCase(),hasAudioMetadata=Boolean(f.audioQuality||f.audioSampleRate||f.audioChannels||f.audioCodec),noVideoMetadata=!f.qualityLabel&&!f.resolution;
    const audioContainer=/^(m4a|mp4|webm|ogg|opus)$/i.test(String(f.container||''));
    return Boolean(f.itag)&&(type.startsWith('audio/')||(hasAudioMetadata&&noVideoMetadata)||(audioContainer&&hasAudioMetadata&&noVideoMetadata));
  }).map(f=>{
    const proxyUrl=`${result.base}/latest_version?id=${encodeURIComponent(videoId)}&itag=${encodeURIComponent(f.itag)}&local=true`;
    let directUrl='';try{const candidate=new URL(f.url||'',result.base),isGoogleVideo=candidate.protocol==='https:'&&candidate.hostname.toLowerCase().endsWith('.googlevideo.com'),isInstanceStream=candidate.origin===instanceOrigin&&/^\/(?:companion\/)?latest_version(?:\/|$)/.test(candidate.pathname);if(isGoogleVideo||isInstanceStream)directUrl=candidate.href}catch{}
    const type=String(f.type||'');const normalizedType=type.toLowerCase().startsWith('audio/')?type:(/webm|opus/i.test(`${f.container||''} ${f.encoding||''}`)?'audio/webm; codecs="opus"':'audio/mp4');
    const sources=[...new Set([directUrl,proxyUrl].filter(Boolean))];
    return {...f,type:normalizedType,url:sources[0],sources};
  }).sort((a,b)=>Number(b.type.includes('audio/webm'))-Number(a.type.includes('audio/webm'))||(parseInt(b.bitrate)||0)-(parseInt(a.bitrate)||0));
}
function looksLikeErrorPayload(bytes){
  const prefix=Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/,'').trimStart().slice(0,256).toLowerCase();
  return /^(?:<!doctype\s+html|<html\b|<head\b|<body\b|\{\s*["'{[]|\[\s*\{)/i.test(prefix);
}
function send(res,status,body){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(body));}
function httpError(message,statusCode=400){return Object.assign(new Error(message),{statusCode});}
async function readJsonBody(req,maxBytes=262144){
  const chunks=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>maxBytes)throw httpError('Request body too large',413);chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}')}catch{throw httpError('Invalid JSON body',400)}
}
function defaultLibrary(){return {categories:INITIAL_CATEGORIES.map(category=>({...category})),tracks:[]};}
function normalizeVideoThumbnails(thumbnails,base='https://i.ytimg.com/'){
  return (Array.isArray(thumbnails)?thumbnails:[]).map(thumb=>{
    try{const url=new URL(String(thumb?.url||''),base);if(!['http:','https:'].includes(url.protocol))return null;return {...thumb,url:url.href};}catch{return null;}
  }).filter(Boolean);
}
async function readLocalLibrary(){
  try{
    const library=JSON.parse(await readFile(LIBRARY_FILE,'utf8'));
    if(!Array.isArray(library.categories)||!Array.isArray(library.tracks))throw new Error('Library data has an invalid format.');
    return {...library,tracks:library.tracks.map(track=>track?.kind==='youtube'?{...track,videoThumbnails:normalizeVideoThumbnails(track.videoThumbnails)}:track)};
  }catch(error){if(error.code==='ENOENT')return defaultLibrary();throw error;}
}
async function saveLocalLibrary(library){
  await mkdir(path.dirname(LIBRARY_FILE),{recursive:true});
  const temporary=LIBRARY_FILE+'.'+process.pid+'.'+randomBytes(5).toString('hex')+'.tmp';
  await writeFile(temporary,JSON.stringify(library,null,2)+'\n','utf8');
  await rename(temporary,LIBRARY_FILE);
}
async function getCatalystTable(req){
  const [{zcAuth},{Datastore}]=await Promise.all([import('@zcatalyst/auth'),import('@zcatalyst/datastore')]);
  const app=await zcAuth.init(req,{scope:'admin'});
  return new Datastore(app).table(CATALYST_LIBRARY_TABLE);
}
async function catalystRows(table){
  const rows=[];let nextToken,hasMore=true;const seenTokens=new Set();
  while(hasMore){
    const page=await table.getPagedRows({nextToken,maxRows:200});
    rows.push(...(Array.isArray(page?.data)?page.data:[]));
    hasMore=Boolean(page?.more_records);nextToken=page?.next_token;
    if(hasMore&&(!nextToken||seenTokens.has(nextToken)))throw new Error('Catalyst Data Store pagination returned an invalid next token.');
    if(nextToken)seenTokens.add(nextToken);
  }
  return rows;
}
function catalystRecords(library){
  const records=[];
  library.categories.forEach((category,position)=>records.push({RecordId:'cat:'+category.id,Kind:'category',CategoryId:category.id,Position:position,Payload:JSON.stringify(category)}));
  library.tracks.forEach((track,position)=>records.push({RecordId:'track:'+track.id,Kind:'track',CategoryId:track.categoryId,Position:position,Payload:JSON.stringify(track)}));
  return records;
}
function libraryFromCatalystRows(rows){
  const categories=[],tracks=[];
  for(const row of rows){
    try{
      const payload=JSON.parse(row.Payload);
      if(row.Kind==='category')categories.push({position:Number(row.Position)||0,value:payload});
      else if(row.Kind==='track')tracks.push({position:Number(row.Position)||0,value:payload});
    }catch{throw new Error(`Catalyst Data Store record ${String(row.RecordId||row.ROWID)} has invalid JSON.`);}
  }
  categories.sort((a,b)=>a.position-b.position);tracks.sort((a,b)=>a.position-b.position);
  if(!categories.length)return defaultLibrary();
  return {categories:categories.map(item=>item.value),tracks:tracks.map(item=>item.value?.kind==='youtube'?{...item.value,videoThumbnails:normalizeVideoThumbnails(item.value.videoThumbnails)}:item.value)};
}
async function writeCatalystLibrary(table,library,existingRows){
  const wanted=catalystRecords(library),existing=new Map(existingRows.map(row=>[String(row.RecordId),row])),wantedIds=new Set(wanted.map(row=>row.RecordId));
  const inserts=[],updates=[];
  for(const values of wanted){
    const old=existing.get(values.RecordId);
    if(!old){inserts.push(values);continue;}
    if(old.Payload!==values.Payload||old.CategoryId!==values.CategoryId||Number(old.Position)!==values.Position)updates.push({...values,ROWID:old.ROWID});
  }
  for(let offset=0;offset<inserts.length;offset+=100)await table.insertRows(inserts.slice(offset,offset+100));
  for(let offset=0;offset<updates.length;offset+=100)await table.updateRows(updates.slice(offset,offset+100));
  const deletes=existingRows.filter(row=>row.RecordId&&row.RecordId!=='__meta__'&&!wantedIds.has(String(row.RecordId)));
  let cursor=0;const workers=Array.from({length:Math.min(8,deletes.length)},async()=>{while(cursor<deletes.length){const row=deletes[cursor++];await table.deleteRow(row.ROWID);}});
  await Promise.all(workers);
}
async function bootstrapCatalystLibrary(table,req,rows){
  if(catalystBootstrapPromise)return catalystBootstrapPromise;
  catalystBootstrapPromise=(async()=>{
    const initial=await readLocalLibrary();let meta=rows.find(row=>row.RecordId==='__meta__'),ownsSeed=false;
    if(!meta){
      try{meta=await table.insertRow({RecordId:'__meta__',Kind:'meta',Position:0,Payload:JSON.stringify({seeded:false})});ownsSeed=true;}
      catch(error){
        rows=await catalystRows(table);meta=rows.find(row=>row.RecordId==='__meta__');
        if(!meta){if(rows.some(row=>row.Kind==='category'))return rows;throw error;}
      }
    }
    let state={};try{state=JSON.parse(meta.Payload||'{}')}catch{}
    if(state.seeded)return rows;
    if(!ownsSeed){
      for(let attempt=0;attempt<60;attempt++){
        await new Promise(resolve=>setTimeout(resolve,500));
        rows=await catalystRows(table);meta=rows.find(row=>row.RecordId==='__meta__');
        try{state=JSON.parse(meta?.Payload||'{}')}catch{state={}}
        if(state.seeded)return rows;
      }
      throw new Error('Catalyst Data Store initial seed is still in progress. Retry shortly.');
    }
    await writeCatalystLibrary(table,initial,rows);
    await table.updateRow({ROWID:meta.ROWID,Payload:JSON.stringify({seeded:true,version:1})});
    return catalystRows(table);
  })();
  try{return await catalystBootstrapPromise}
  finally{catalystBootstrapPromise=null;}
}
async function readLibrary(req){
  if(!CATALYST_DATASTORE)return readLocalLibrary();
  const table=await getCatalystTable(req);let rows=await catalystRows(table);
  if(!rows.some(row=>row.Kind==='category')||rows.some(row=>row.RecordId==='__meta__'&&(()=>{try{return !JSON.parse(row.Payload||'{}').seeded}catch{return true}})()))rows=await bootstrapCatalystLibrary(table,req,rows);
  return libraryFromCatalystRows(rows);
}
async function saveLibrary(library,req){
  if(!CATALYST_DATASTORE)return saveLocalLibrary(library);
  const table=await getCatalystTable(req),rows=await catalystRows(table);
  await writeCatalystLibrary(table,library,rows);
}
function adminSession(req){
  const match=/^Bearer ([a-f0-9]{64})$/i.exec(req.headers.authorization||'');
  if(!match)return false;
  const expires=adminSessions.get(match[1]);
  if(!expires||expires<Date.now()){adminSessions.delete(match[1]);return false;}
  return true;
}
function validCategory(library,id){return library.categories.some(category=>category.id===id);}
function normalizeImportedLibrary(value){
  if(!value||typeof value!=='object'||!Array.isArray(value.categories)||!Array.isArray(value.tracks))throw httpError('Backup JSON-এ categories এবং tracks list থাকতে হবে।');
  if(value.categories.length<1||value.categories.length>100||value.tracks.length>5000)throw httpError('Backup-এ category বা গানের সংখ্যা অনুমোদিত সীমার বাইরে।');
  const categoryIds=new Set(),categoryNames=new Set();
  const categories=value.categories.map(item=>{
    const id=String(item?.id||''),name=String(item?.name||'').trim(),key=name.toLowerCase();
    if(!/^[A-Za-z0-9_-]{1,80}$/.test(id)||!name||name.length>50||categoryIds.has(id)||categoryNames.has(key))throw httpError('Backup-এ category data invalid বা duplicate।');
    categoryIds.add(id);categoryNames.add(key);return {id,name};
  });
  const trackIds=new Set();
  const tracks=value.tracks.map(item=>{
    const id=String(item?.id||''),kind=String(item?.kind||''),title=String(item?.title||'').trim(),author=String(item?.author||'').trim(),categoryId=String(item?.categoryId||'');
    if(!/^[A-Za-z0-9_-]{1,80}$/.test(id)||trackIds.has(id)||!['youtube','external'].includes(kind)||!title||title.length>200||!author||author.length>200||!categoryIds.has(categoryId))throw httpError('Backup-এ song data invalid বা duplicate।');
    trackIds.add(id);
    const addedAt=typeof item.addedAt==='string'&&item.addedAt.length<=80?item.addedAt:new Date().toISOString();
    if(kind==='youtube'){
      const videoId=String(item.videoId||'');if(!/^[A-Za-z0-9_-]{11}$/.test(videoId))throw httpError('Backup-এ YouTube video ID invalid।');
      const videoThumbnails=normalizeVideoThumbnails(item.videoThumbnails).slice(0,20).map(thumb=>({...thumb,quality:String(thumb.quality||'').slice(0,40),width:Number(thumb.width)||0,height:Number(thumb.height)||0}));
      return {id,kind,videoId,title,author,lengthSeconds:Math.max(0,Number(item.lengthSeconds)||0),videoThumbnails,categoryId,addedAt};
    }
    const audioUrl=normalizeExternalAudioUrl(String(item.audioUrl||item.url||''));
    return {id,kind,audioUrl,title,author,lengthSeconds:Math.max(0,Number(item.lengthSeconds)||0),categoryId,addedAt};
  });
  return {categories,tracks};
}
function parseYouTubeUrl(value){
  let url;try{url=new URL(value)}catch{throw httpError('একটি valid YouTube link দিন।')}
  const host=url.hostname.toLowerCase().replace(/^www\./,'');
  if(!['youtube.com','m.youtube.com','music.youtube.com','youtu.be'].includes(host))throw httpError('YouTube video বা playlist link দিন।');
  const playlistId=url.searchParams.get('list');
  if(playlistId&&/^[A-Za-z0-9_-]{10,80}$/.test(playlistId))return {type:'playlist',id:playlistId};
  let videoId=url.searchParams.get('v');
  if(host==='youtu.be')videoId=url.pathname.split('/').filter(Boolean)[0]||'';
  if(!videoId){const parts=url.pathname.split('/').filter(Boolean);if(['shorts','embed','live'].includes(parts[0]))videoId=parts[1]||'';}
  if(!/^[A-Za-z0-9_-]{11}$/.test(videoId||''))throw httpError('এই link-এ YouTube video ID পাওয়া যায়নি।');
  return {type:'video',id:videoId};
}
function normalizeExternalAudioUrl(value){
  let url;try{url=new URL(value)}catch{throw httpError('একটি valid audio link দিন।')}
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw httpError('Audio link-টি HTTP বা HTTPS হতে হবে।');
  if(/(^|\.)drive\.google\.com$/i.test(url.hostname)){
    const id=(url.pathname.match(/\/file\/d\/([^/]+)/)||[])[1]||url.searchParams.get('id');
    if(id&&/^[A-Za-z0-9_-]{10,}$/.test(id))return 'https://drive.google.com/uc?export=download&id='+encodeURIComponent(id);
  }
  return url.href;
}
function contentType(file){return ({'.html':'text/html; charset=utf-8','.png':'image/png','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'})[path.extname(file).toLowerCase()]||'application/octet-stream'}
async function relayAudio(req,res,videoId,url){
  const excluded=url.searchParams.getAll('excludeInstance').filter(x=>/^[A-Za-z0-9.:[\]-]+$/.test(x)).slice(0,4);let lastError='No audio stream was returned.';
  for(let instanceAttempt=0;instanceAttempt<3;instanceAttempt++){
    const result=await loadVideo(videoId,{fresh:instanceAttempt>0||url.searchParams.get('fresh')==='1',exclude:excluded}),formats=audioFormats(result,videoId);
    if(url.searchParams.get('format')==='mp4')formats.sort((a,b)=>Number(b.type.includes('audio/mp4'))-Number(a.type.includes('audio/mp4'))||(parseInt(b.bitrate)||0)-(parseInt(a.bitrate)||0));
    if(!formats.length){coolHost(result.instance,'videos');excluded.push(result.instance);lastError=`${result.instance} returned no usable audio formats.`;continue;}
    for(const format of formats.slice(0,4))for(const streamUrl of format.sources){
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);let upstream;
      try{
        const headers={};if(req.headers.range)headers.range=req.headers.range;
      upstream=await fetch(streamUrl,{method:req.method==='HEAD'?'HEAD':'GET',headers,signal:controller.signal,redirect:'follow'});
        const upstreamType=(upstream.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
        if(upstream.status!==200&&upstream.status!==206){clearTimeout(timer);lastError=`${result.instance} stream returned HTTP ${upstream.status}`;await upstream.body?.cancel();controller.abort();continue;}
        if(upstreamType==='text/html'||upstreamType==='application/json'||upstreamType==='text/plain'){clearTimeout(timer);lastError=`${result.instance} returned a ${upstreamType} page instead of audio`;await upstream.body?.cancel();controller.abort();continue;}
        if(upstreamType&&!upstreamType.startsWith('audio/')&&upstreamType!=='application/octet-stream'&&upstreamType!=='binary/octet-stream'){clearTimeout(timer);lastError=`${result.instance} returned unsupported media type ${upstreamType}`;await upstream.body?.cancel();controller.abort();continue;}
        if(req.method==='HEAD'||!upstream.body){clearTimeout(timer);controller.abort();res.writeHead(upstream.status,{'content-type':upstreamType||format.type,'accept-ranges':upstream.headers.get('accept-ranges')||'bytes','cache-control':'no-store','x-invidious-instance':result.instance,...(upstream.headers.get('content-length')?{'content-length':upstream.headers.get('content-length')}:{}) ,...(upstream.headers.get('content-range')?{'content-range':upstream.headers.get('content-range')}:{})});return res.end();}
        const reader=upstream.body.getReader(),first=await reader.read();clearTimeout(timer);
        if(first.done||!first.value?.byteLength){lastError=`${result.instance} returned an empty audio stream`;await reader.cancel();controller.abort();continue;}
        if(looksLikeErrorPayload(first.value)){lastError=`${result.instance} returned an HTML or JSON error body instead of audio`;await reader.cancel();controller.abort();continue;}
        res.writeHead(upstream.status,{'content-type':upstreamType||format.type,'accept-ranges':upstream.headers.get('accept-ranges')||'bytes','cache-control':'no-store','x-invidious-instance':result.instance,...(upstream.headers.get('content-length')?{'content-length':upstream.headers.get('content-length')}:{}) ,...(upstream.headers.get('content-range')?{'content-range':upstream.headers.get('content-range')}:{})});
        res.on('close',()=>{controller.abort();reader.cancel().catch(()=>{});});
        Readable.from((async function*(){yield first.value;while(true){const next=await reader.read();if(next.done)break;yield next.value;}})()).on('error',()=>{if(!res.destroyed)res.destroy()}).pipe(res);return;
      }catch(error){clearTimeout(timer);controller.abort();lastError=`${result.instance} stream: ${error.message}`;}
    }
    coolHost(result.instance,'videos');excluded.push(result.instance);
  }
  throw new Error(lastError);
}
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  const localFileOrigin=req.headers.origin==='null'&&['127.0.0.1','localhost','::1'].includes(HOST);
  if(localFileOrigin){
    res.setHeader('access-control-allow-origin','null');
    res.setHeader('access-control-allow-methods','GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('access-control-allow-headers','authorization, content-type, range');
    res.setHeader('access-control-max-age','600');
    res.setHeader('vary','Origin');
  }
  if(url.pathname.startsWith('/api/')&&req.method==='OPTIONS'){
    if(!localFileOrigin)return send(res,403,{error:'Cross-origin API request is not allowed'});
    res.writeHead(204);
    return res.end();
  }
  try{
    if(url.pathname==='/health')return send(res,200,{ok:true});
    if(url.pathname==='/favicon.ico'){res.writeHead(204,{'cache-control':'public, max-age=86400'});return res.end();}
    if(url.pathname==='/api/admin/verify'){
      if(req.method!=='POST')return send(res,405,{error:'Method not allowed'});
      if(!ADMIN_PASSCODE)return send(res,503,{error:'Admin passcode is not configured on the server. Start through start-local.bat or set ADMIN_PASSCODE.'});
      const chunks=[];let bytes=0,tooLarge=false;
      for await(const chunk of req){bytes+=chunk.length;if(bytes>4096){tooLarge=true;continue;}chunks.push(chunk);}
      if(tooLarge)return send(res,413,{error:'Request body too large'});
      let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}')}catch{return send(res,400,{error:'Invalid JSON body'});}
      const provided=Buffer.from(typeof body.passcode==='string'?body.passcode:'','utf8');
      const expected=Buffer.from(ADMIN_PASSCODE,'utf8');
      const valid=provided.length===expected.length&&timingSafeEqual(provided,expected);
      if(!valid)return send(res,401,{error:'পাসকোডটি সঠিক নয়।'});
      for(const [token,expires] of adminSessions)if(expires<Date.now())adminSessions.delete(token);
      const token=randomBytes(32).toString('hex');
      adminSessions.set(token,Date.now()+6*60*60_000);
      return send(res,200,{ok:true,token});
    }
    if(url.pathname==='/api/library'&&req.method==='GET'){
      const library=await readLibrary(req);
      return send(res,200,{categories:library.categories,tracks:library.tracks});
    }
    if(url.pathname.startsWith('/api/admin/')){
      if(!adminSession(req))return send(res,401,{error:'Admin session expired. Passcode দিন আবার।'});
      if(url.pathname==='/api/admin/library'&&req.method==='GET'){
        const library=await readLibrary(req);
        return send(res,200,library);
      }
      if(url.pathname==='/api/admin/library'&&req.method==='PUT'){
        const imported=normalizeImportedLibrary(await readJsonBody(req,5*1024*1024));
        await saveLibrary(imported,req);return send(res,200,{ok:true,categories:imported.categories.length,tracks:imported.tracks.length});
      }
      if(url.pathname==='/api/admin/categories'&&req.method==='POST'){
        const body=await readJsonBody(req),name=String(body.name||'').trim();
        if(!name||name.length>50)return send(res,400,{error:'Category name 1–50 character-এর মধ্যে দিন।'});
        const library=await readLibrary(req);
        if(library.categories.some(category=>category.name.toLowerCase()===name.toLowerCase()))return send(res,409,{error:'এই category আগে থেকেই আছে।'});
        const category={id:randomUUID(),name};library.categories.push(category);await saveLibrary(library,req);
        return send(res,201,{category});
      }
      const categoryMatch=/^\/api\/admin\/categories\/([^/]+)$/.exec(url.pathname);
      if(categoryMatch){
        const id=decodeURIComponent(categoryMatch[1]),library=await readLibrary(req),index=library.categories.findIndex(category=>category.id===id);
        if(index<0)return send(res,404,{error:'Category পাওয়া যায়নি।'});
        if(req.method==='PATCH'){
          const body=await readJsonBody(req),name=String(body.name||'').trim();
          if(!name||name.length>50)return send(res,400,{error:'Category name 1–50 character-এর মধ্যে দিন।'});
          if(library.categories.some(category=>category.id!==id&&category.name.toLowerCase()===name.toLowerCase()))return send(res,409,{error:'এই category আগে থেকেই আছে।'});
          library.categories[index].name=name;await saveLibrary(library,req);return send(res,200,{category:library.categories[index]});
        }
        if(req.method==='DELETE'){
          if(library.categories.length<=1)return send(res,409,{error:'কমপক্ষে একটি category রাখতে হবে।'});
          if(library.tracks.some(track=>track.categoryId===id))return send(res,409,{error:'এই category-তে গান আছে। আগে গানগুলো সরান।'});
          library.categories.splice(index,1);await saveLibrary(library,req);return send(res,200,{ok:true});
        }
      }
      if(url.pathname==='/api/admin/tracks/youtube'&&req.method==='POST'){
        const body=await readJsonBody(req),parsed=parseYouTubeUrl(String(body.url||''));
        const library=await readLibrary(req),categoryId=String(body.categoryId||'');
        if(!validCategory(library,categoryId))return send(res,400,{error:'একটি category বেছে নিন।'});
        let videos=[],thumbnailBase='https://i.ytimg.com/';
        if(parsed.type==='playlist'){
          const result=await invidious('/api/v1/playlists/'+encodeURIComponent(parsed.id));
          videos=result.data.videos||[];thumbnailBase=result.base||thumbnailBase;
        }else{
          const result=await loadVideo(parsed.id);
          videos=[{videoId:parsed.id,title:result.data.title,author:result.data.author,lengthSeconds:result.data.lengthSeconds,videoThumbnails:result.data.videoThumbnails}];thumbnailBase=result.base||thumbnailBase;
        }
        if(!videos.length)return send(res,404,{error:'এই YouTube playlist-এ public গান পাওয়া যায়নি।'});
        let added=0,skipped=0;
        for(const video of videos){
          if(!/^[A-Za-z0-9_-]{11}$/.test(video.videoId||'')){skipped++;continue;}
          if(library.tracks.some(track=>track.kind==='youtube'&&track.videoId===video.videoId&&track.categoryId===categoryId)){skipped++;continue;}
          library.tracks.push({id:randomUUID(),kind:'youtube',videoId:video.videoId,title:String(video.title||'Untitled'),author:String(video.author||'YouTube'),lengthSeconds:Number(video.lengthSeconds)||0,videoThumbnails:normalizeVideoThumbnails(video.videoThumbnails,thumbnailBase),categoryId,addedAt:new Date().toISOString()});
          added++;
        }
        if(added)await saveLibrary(library,req);
        return send(res,201,{ok:true,added,skipped,type:parsed.type});
      }
      if(url.pathname==='/api/admin/tracks/link'&&req.method==='POST'){
        const body=await readJsonBody(req),library=await readLibrary(req),categoryId=String(body.categoryId||''),title=String(body.title||'').trim(),artist=String(body.artist||'').trim();
        if(!validCategory(library,categoryId))return send(res,400,{error:'একটি category বেছে নিন।'});
        if(!title||title.length>200||!artist||artist.length>200)return send(res,400,{error:'গানের name ও artist 1–200 character-এর মধ্যে দিন।'});
        const audioUrl=normalizeExternalAudioUrl(String(body.url||''));
        const track={id:randomUUID(),kind:'external',audioUrl,title,author:artist,lengthSeconds:0,categoryId,addedAt:new Date().toISOString()};
        library.tracks.push(track);await saveLibrary(library,req);return send(res,201,{ok:true,track});
      }
      if(url.pathname==='/api/admin/tracks/order'&&req.method==='PUT'){
        const body=await readJsonBody(req),ids=body.trackIds;
        if(!Array.isArray(ids)||ids.length>5000||ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length)return send(res,400,{error:'Playlist order invalid।'});
        const library=await readLibrary(req),byId=new Map(library.tracks.map(track=>[track.id,track]));
        if(ids.length!==library.tracks.length||ids.some(id=>!byId.has(id)))return send(res,409,{error:'Track list বদলে গেছে। Refresh করে আবার order দিন।'});
        library.tracks=ids.map(id=>byId.get(id));await saveLibrary(library,req);return send(res,200,{ok:true});
      }
      const trackMatch=/^\/api\/admin\/tracks\/([^/]+)$/.exec(url.pathname);
      if(trackMatch&&req.method==='PATCH'){
        const id=decodeURIComponent(trackMatch[1]),library=await readLibrary(req),index=library.tracks.findIndex(track=>track.id===id);
        if(index<0)return send(res,404,{error:'গান পাওয়া যায়নি।'});
        const body=await readJsonBody(req),track=library.tracks[index],title=String(body.title??track.title).trim(),author=String(body.author??track.author??'').trim(),categoryId=String(body.categoryId??track.categoryId);
        if(!title||title.length>200||!author||author.length>200)return send(res,400,{error:'গানের নাম ও শিল্পী 1–200 character-এর মধ্যে দিন।'});
        if(!validCategory(library,categoryId))return send(res,400,{error:'একটি valid category বেছে নিন।'});
        const updated={...track,title,author,categoryId};
        if(track.kind==='external')updated.audioUrl=normalizeExternalAudioUrl(String(body.audioUrl??track.audioUrl??''));
        library.tracks[index]=updated;await saveLibrary(library,req);return send(res,200,{ok:true,track:updated});
      }
      if(trackMatch&&req.method==='DELETE'){
        const id=decodeURIComponent(trackMatch[1]),library=await readLibrary(req),index=library.tracks.findIndex(track=>track.id===id);
        if(index<0)return send(res,404,{error:'গান পাওয়া যায়নি।'});
        library.tracks.splice(index,1);await saveLibrary(library,req);return send(res,200,{ok:true});
      }
      return send(res,405,{error:'Admin route or method not found'});
    }
    if(url.pathname==='/api/playlist'){
      const playlistId=url.searchParams.get('playlistId')||DEFAULT_PLAYLIST;if(!/^[A-Za-z0-9_-]{10,80}$/.test(playlistId))return send(res,400,{error:'Invalid playlist ID'});
      const key=`playlist:${playlistId}`;let result=cache.get(key);if(!result||Date.now()-result.time>10*60_000){const fetched=await invidious(`/api/v1/playlists/${encodeURIComponent(playlistId)}`);result={time:Date.now(),data:fetched.data,instance:fetched.host,base:fetched.base};cache.set(key,result)}
      const p=result.data,thumbnailBase=result.base||`https://${result.instance}`;return send(res,200,{title:p.title,playlistId:p.playlistId,author:p.author,videoCount:p.videoCount,videos:(p.videos||[]).map(v=>({title:v.title,videoId:v.videoId,author:v.author,lengthSeconds:v.lengthSeconds,videoThumbnails:normalizeVideoThumbnails(v.videoThumbnails,thumbnailBase)})),instance:result.instance});
    }
    if(url.pathname==='/api/video'){
      const videoId=url.searchParams.get('videoId')||'';if(!/^[A-Za-z0-9_-]{11}$/.test(videoId))return send(res,400,{error:'Invalid video ID'});
      const excluded=url.searchParams.getAll('excludeInstance').filter(x=>/^[A-Za-z0-9.:[\]-]+$/.test(x)).slice(0,4),result=await loadVideo(videoId,{fresh:url.searchParams.get('fresh')==='1',exclude:excluded}),formats=audioFormats(result,videoId);
      return send(res,200,{title:result.data.title,lengthSeconds:result.data.lengthSeconds,adaptiveFormats:formats.map(f=>({type:f.type,itag:f.itag,bitrate:f.bitrate})),instance:result.instance});
    }
    if(url.pathname==='/api/audio'){
      const videoId=url.searchParams.get('videoId')||'';if(!/^[A-Za-z0-9_-]{11}$/.test(videoId))return send(res,400,{error:'Invalid video ID'});if(req.method!=='GET'&&req.method!=='HEAD')return send(res,405,{error:'Method not allowed'});await relayAudio(req,res,videoId,url);return;
    }
    let decoded;try{decoded=decodeURIComponent(url.pathname)}catch{return send(res,400,{error:'Bad path'})}
    const relative=decoded==='/'?'index.html':decoded.replace(/^\/+/, '');const file=path.resolve(ROOT,relative);if(file!==ROOT&&!file.startsWith(ROOT+path.sep))return send(res,403,{error:'Forbidden'});
    const info=await stat(file);if(!info.isFile())return send(res,404,{error:'Not found'});res.writeHead(200,{'content-type':contentType(file),'content-length':info.size,'x-content-type-options':'nosniff'});res.end(await readFile(file));
  }catch(error){if(error.code!=='ENOENT')console.error(error.message);if(!res.headersSent)send(res,error.statusCode||502,{error:error.message});else res.destroy();}
});
server.listen(PORT,HOST,()=>console.log(`Aagomoni Suro listening on ${HOST}:${PORT}\nRange-capable audio relay enabled.`));



