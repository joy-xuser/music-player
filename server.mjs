import http from 'node:http';
import {Readable} from 'node:stream';
import {readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const PLATFORM_PORT=process.env.PORT||process.env.X_ZOHO_CATALYST_LISTEN_PORT;
const PORT=Number(PLATFORM_PORT||4173);
const HOST=process.env.HOST||(PLATFORM_PORT?'0.0.0.0':'127.0.0.1');
const DEFAULT_PLAYLIST='PLTSRCGR4a75c';
const FALLBACK_HOSTS=['invidious.f5.si','inv.nadeko.net','invidious.flokinet.to','yewtu.be'];
const CONFIGURED_INSTANCE=(process.env.INVIDIOUS_INSTANCE||'').trim();
const cache=new Map(),hostCooldowns=new Map();
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
  try{
    if(url.pathname==='/health')return send(res,200,{ok:true});
    if(url.pathname==='/api/playlist'){
      const playlistId=url.searchParams.get('playlistId')||DEFAULT_PLAYLIST;if(!/^[A-Za-z0-9_-]{10,80}$/.test(playlistId))return send(res,400,{error:'Invalid playlist ID'});
      const key=`playlist:${playlistId}`;let result=cache.get(key);if(!result||Date.now()-result.time>10*60_000){const fetched=await invidious(`/api/v1/playlists/${encodeURIComponent(playlistId)}`);result={time:Date.now(),data:fetched.data,instance:fetched.host};cache.set(key,result)}
      const p=result.data;return send(res,200,{title:p.title,playlistId:p.playlistId,author:p.author,videoCount:p.videoCount,videos:(p.videos||[]).map(v=>({title:v.title,videoId:v.videoId,author:v.author,lengthSeconds:v.lengthSeconds,videoThumbnails:v.videoThumbnails})),instance:result.instance});
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
  }catch(error){console.error(error.message);if(!res.headersSent)send(res,502,{error:error.message});else res.destroy();}
});
server.listen(PORT,HOST,()=>console.log(`Aagomoni Suro listening on ${HOST}:${PORT}\nRange-capable audio relay enabled.`));




