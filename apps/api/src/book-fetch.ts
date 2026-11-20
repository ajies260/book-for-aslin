import {TextDecoder} from 'node:util';

export type BookFetchCode='timeout'|'dns'|'blocked'|'redirect'|'content-type'|'http'|'too-large'|'empty'|'parse'|'network';
export type BookFetchMeta={label?:string;host:string;finalHost?:string;status?:number;contentType?:string;attempt?:number};
export type DownloadOptions={label?:string;accept?:string;headers?:Record<string,string>;timeoutMs?:number;retries?:number;maxBytes?:number;expected?:RegExp};
export type DownloadResult<T>={value:T;status:number;contentType:string;finalHost:string;bytes:number;redirected:boolean};

export class BookFetchError extends Error{
 code:BookFetchCode;
 meta:BookFetchMeta;
 constructor(code:BookFetchCode,message:string,meta:BookFetchMeta){super(message);this.name='BookFetchError';this.code=code;this.meta=meta}
}

const DEFAULT_ACCEPT='text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7';
const HEADERS={
 'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 ForYouBooks/1.0',
 'Accept-Language':'en-US,en;q=0.9',
 'Cache-Control':'no-cache'
};
function hostOf(value:string){try{return new URL(value).host}catch{return 'invalid-host'}}
function classify(error:any,status?:number):BookFetchCode{
 if(status===401||status===403||status===407)return 'blocked';
 if(status&&status>=300&&status<400)return 'redirect';
 if(status===408||status===425||status===429||(status??0)>=500)return 'http';
 const name=String(error?.name||''),message=String(error?.message||'').toLowerCase(),cause=[String(error?.cause?.code||''),String(error?.cause?.message||'')].join(' ').toLowerCase(),all=`${message} ${cause}`;
 if(name==='TimeoutError'||name==='AbortError'||/timeout|timed out|aborted/.test(all))return 'timeout';
 if(/enotfound|eai_again|getaddrinfo|dns|econnrefused|enetunreach|network is unreachable/.test(all))return 'dns';
 if(/redirect|too many redirects/.test(all))return 'redirect';
 if(status)return 'http';
 return 'network';
}
function normalizeError(error:unknown,meta:BookFetchMeta,attempt:number):BookFetchError{
 if(error instanceof BookFetchError)return new BookFetchError(error.code,error.message,{...error.meta,...meta,attempt});
 const status=Number((error as any)?.status||0)||undefined;
 return new BookFetchError(classify(error,status),error instanceof Error?error.message:'Source download failed',{...meta,attempt,status});
}
function retryable(error:BookFetchError){return error.code==='timeout'||error.code==='dns'||error.code==='network'||error.code==='redirect'||error.meta.status===408||error.meta.status===425||error.meta.status===429||(typeof error.meta.status==='number'&&error.meta.status>=500)}
function logFailure(error:BookFetchError){console.warn('Book source download failed',JSON.stringify({type:error.code,label:error.meta.label||null,host:error.meta.host,finalHost:error.meta.finalHost||null,status:error.meta.status||null,contentType:error.meta.contentType||null,attempt:error.meta.attempt||null,message:error.message.slice(0,300)}))}
function sleep(ms:number){return new Promise<void>(resolve=>setTimeout(resolve,ms))}
async function downloadWithRetry<T>(url:string,options:DownloadOptions,read:(response:Response,meta:BookFetchMeta)=>Promise<{value:T;bytes:number}>):Promise<DownloadResult<T>>{
 const host=hostOf(url),label=options.label||host,attempts=Math.max(1,(options.retries??2)+1);
 let last:BookFetchError|undefined;
 for(let attempt=1;attempt<=attempts;attempt++){
  let response:Response|undefined;
  let meta:BookFetchMeta={label,host,attempt};
  try{
   response=await fetch(url,{headers:{...HEADERS,...options.headers,Accept:options.accept||DEFAULT_ACCEPT},redirect:'follow',signal:AbortSignal.timeout(options.timeoutMs??30000)});
   meta={...meta,finalHost:hostOf(response.url||url),status:response.status,contentType:response.headers.get('content-type')||''};
   if(response.status>=300&&response.status<400)throw new BookFetchError('redirect',`Source redirect could not be completed (${response.status})`,meta);
   if(response.status===401||response.status===403||response.status===407)throw new BookFetchError('blocked',`Source blocked the request (${response.status})`,meta);
   if(!response.ok)throw new BookFetchError('http',`Source returned HTTP ${response.status}`,meta);
   if(options.expected&&!options.expected.test(meta.contentType!.toLowerCase()))throw new BookFetchError('content-type',`Unexpected content type ${meta.contentType||'unknown'}`,meta);
   const readResult=await read(response,meta);
   return {value:readResult.value,status:response.status,contentType:meta.contentType!,finalHost:meta.finalHost!,bytes:readResult.bytes,redirected:response.redirected};
  }catch(error){
   if(response&&!response.bodyUsed)await response.body?.cancel().catch(()=>{});
   last=normalizeError(error,meta,attempt);
   logFailure(last);
   if(attempt<attempts&&retryable(last)){await sleep(attempt===1?500:1500);continue}
   throw last;
  }
 }
 throw last!;
}
async function readText(response:Response,maxBytes:number,meta:BookFetchMeta){
 const length=Number(response.headers.get('content-length')||0);
 if(Number.isFinite(length)&&length>maxBytes)throw new BookFetchError('too-large',`Source body is too large (${length} bytes)`,meta);
 const reader=response.body?.getReader();
 if(!reader){const value=await response.text(),bytes=Buffer.byteLength(value);if(bytes>maxBytes)throw new BookFetchError('too-large',`Source body is too large (${bytes} bytes)`,meta);if(!value.trim())throw new BookFetchError('empty','Source returned no readable text',meta);return {value,bytes}}
 const decoder=new TextDecoder('utf-8');let value='',bytes=0;
 try{
  while(true){const {done,value:chunk}=await reader.read();if(done)break;bytes+=chunk.byteLength;if(bytes>maxBytes){await reader.cancel();throw new BookFetchError('too-large',`Source body is too large (${bytes} bytes)`,meta)}value+=decoder.decode(chunk,{stream:true})}
  value+=decoder.decode();
 }finally{reader.releaseLock()}
 if(!value.trim())throw new BookFetchError('empty','Source returned no readable text',meta);
 return {value,bytes};
}
async function readBuffer(response:Response,maxBytes:number,meta:BookFetchMeta){
 const length=Number(response.headers.get('content-length')||0);
 if(Number.isFinite(length)&&length>maxBytes)throw new BookFetchError('too-large',`Source body is too large (${length} bytes)`,meta);
 const reader=response.body?.getReader();
 if(!reader){const value=Buffer.from(await response.arrayBuffer());if(value.length>maxBytes)throw new BookFetchError('too-large',`Source body is too large (${value.length} bytes)`,meta);if(!value.length)throw new BookFetchError('empty','Source returned no file data',meta);return {value,bytes:value.length}}
 const chunks:Buffer[]=[];let bytes=0;
 try{
  while(true){const {done,value:chunk}=await reader.read();if(done)break;bytes+=chunk.byteLength;if(bytes>maxBytes){await reader.cancel();throw new BookFetchError('too-large',`Source body is too large (${bytes} bytes)`,meta)}chunks.push(Buffer.from(chunk))}
 }finally{reader.releaseLock()}
 if(!bytes)throw new BookFetchError('empty','Source returned no file data',meta);
 return {value:Buffer.concat(chunks,bytes),bytes};
}
export async function fetchBookText(url:string,options:DownloadOptions={}){
 const expected=options.expected||/text\/|json|xml|octet-stream/i,maxBytes=options.maxBytes??8*1024*1024;
 return downloadWithRetry(url,{...options,expected},(response,meta)=>readText(response,maxBytes,meta));
}
export async function fetchBookJson<T>(url:string,options:DownloadOptions={}){
 const result=await fetchBookText(url,{accept:'application/json,text/plain;q=0.9,*/*;q=0.8',expected:/json|text\/plain/i,...options});
 try{return {...result,value:JSON.parse(result.value) as T}}
 catch{throw new BookFetchError('parse','Source returned invalid JSON',{label:options.label||hostOf(url),host:hostOf(url),finalHost:result.finalHost,status:result.status,contentType:result.contentType})}
}
export async function fetchBookBuffer(url:string,options:DownloadOptions={}){
 const expected=options.expected||/pdf|zip|epub|octet-stream/i,maxBytes=options.maxBytes??80*1024*1024;
 return downloadWithRetry(url,{...options,expected},(response,meta)=>readBuffer(response,maxBytes,meta));
}
