import 'express-async-errors';
import 'dotenv/config';
import dotenv from 'dotenv';
import express,{Request,Response,NextFunction} from 'express';
import {spawn,ChildProcessWithoutNullStreams} from 'node:child_process';import {createHash} from 'node:crypto';import {existsSync} from 'node:fs';import {createInterface} from 'node:readline';
import {SessionData} from 'express-session';
import {mkdir,mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {Readable,Transform} from 'node:stream';import {pipeline} from 'node:stream/promises';
import cors from 'cors';import helmet from 'helmet';import session from 'express-session';import rateLimit from 'express-rate-limit';import argon2 from 'argon2';import {z} from 'zod';import {PrismaClient} from '@prisma/client';import {fetchGutenbergEpub,gutenberg} from './adapters/gutendex';import {getWikisourceText,wikisource} from './adapters/wikisource';import {Book,Format} from './adapters/types';import {openLibrary} from './adapters/openlibrary';import {projectMadurai,getProjectMaduraiText} from './adapters/projectmadurai';import {openTextbooks} from './adapters/opentextbooks';import {BookFetchError,fetchBookBuffer,fetchBookText} from './book-fetch';
dotenv.config({path:resolve(process.cwd(),'../../.env')});
const app=express(), prisma=new PrismaClient(), PORT=Number(process.env.PORT||4000); const adapters=[gutenberg,wikisource,openLibrary,projectMadurai];
if(!process.env.SESSION_SECRET)throw new Error('SESSION_SECRET must be set in .env.');
class PrismaSessionStore extends session.Store{
 get(sid:string,callback:(err:any,session?:SessionData|null)=>void){prisma.session.findUnique({where:{sid}}).then(row=>{if(!row||row.expiresAt.getTime()<=Date.now()){if(row)void prisma.session.delete({where:{sid}}).catch(()=>{});return callback(null,null)}callback(null,JSON.parse(row.data) as SessionData)}).catch(callback)}
 set(sid:string,value:SessionData,callback?:(err?:any)=>void){const expiresAt=value.cookie?.expires?new Date(value.cookie.expires):new Date(Date.now()+365*24*60*60*1000);prisma.session.upsert({where:{sid},create:{sid,data:JSON.stringify(value),expiresAt},update:{data:JSON.stringify(value),expiresAt}}).then(()=>callback?.()).catch(err=>callback?.(err))}
 destroy(sid:string,callback?:(err?:any)=>void){prisma.session.deleteMany({where:{sid}}).then(()=>callback?.()).catch(err=>callback?.(err))}
 touch(sid:string,value:SessionData,callback?:(err?:any)=>void){const expiresAt=value.cookie?.expires?new Date(value.cookie.expires):new Date(Date.now()+365*24*60*60*1000);prisma.session.updateMany({where:{sid},data:{expiresAt}}).then(()=>callback?.()).catch(err=>callback?.(err))}
}
const searchCache=new Map<string,{expires:number;value:{books:Book[];total?:number;next?:string|null}}>();
const inFlight=new Map<string,Promise<{books:Book[];total?:number;next?:string|null}>>();
const sourceLastRequest=new Map<string,number>();
let localTranslationWorker:ChildProcessWithoutNullStreams|null=null;let localTranslationSequence=0;const localTranslationPending=new Map<number,{resolve:(value:string)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
function getLocalTranslationWorker(){if(localTranslationWorker)return localTranslationWorker;const python=resolve(process.cwd(),'.venv/bin/python');const script=resolve(process.cwd(),'src/translation_worker.py');if(!existsSync(python))throw new Error('Local translation is not installed yet. Run npm run setup:translation once, then restart the app.');localTranslationWorker=spawn(python,[script],{env:{...process.env,HF_HOME:resolve(process.cwd(),'data/translation-model'),TRANSFORMERS_CACHE:resolve(process.cwd(),'data/translation-model'),HF_HUB_DISABLE_XET:'1',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'}});const worker=localTranslationWorker;const lines=createInterface({input:worker.stdout});lines.on('line',line=>{try{const reply=JSON.parse(line);if(reply.warming){console.log('Loading the local translation model...');return;}if(reply.warmup){console.log('Local translator ready.');return;}const pending=localTranslationPending.get(reply.id);if(!pending)return;clearTimeout(pending.timer);localTranslationPending.delete(reply.id);if(reply.error)pending.reject(new Error(reply.error));else pending.resolve(reply.translation)}catch(error){console.error('Could not read local translation response:',error)}});const rejectPending=(error:Error)=>{for(const [id,pending]of localTranslationPending){clearTimeout(pending.timer);pending.reject(error);localTranslationPending.delete(id)}};worker.on('error',error=>{rejectPending(error);if(localTranslationWorker===worker)localTranslationWorker=null});worker.on('exit',code=>{rejectPending(new Error(`Local translation worker stopped (${code??'unknown'}).`));if(localTranslationWorker===worker)localTranslationWorker=null});return worker;}
function translateLocally(text:string,source:string,target:string){const worker=getLocalTranslationWorker(),id=++localTranslationSequence;return new Promise<string>((resolvePromise,rejectPromise)=>{const timer=setTimeout(()=>{localTranslationPending.delete(id);rejectPromise(new Error('Local translation timed out. Please try that passage again.'))},10*60_000);localTranslationPending.set(id,{resolve:resolvePromise,reject:rejectPromise,timer});worker.stdin.write(`${JSON.stringify({id,text,source,target})}\n`,error=>{if(error){clearTimeout(timer);localTranslationPending.delete(id);rejectPromise(error)}})})}
type TranslationErrorInfo={code?:string;provider?:string;status?:number};
class TranslationError extends Error{
 code:string;provider:string;status?:number;
 constructor(message:string,info:TranslationErrorInfo={}){super(message);this.name='TranslationError';this.code=info.code||'TRANSLATION_FAILED';this.provider=info.provider||'unknown';this.status=info.status}
}
class GooglePermissionError extends TranslationError{constructor(message:string){super(message,{code:'GOOGLE_KEY_NOT_AUTHORIZED',provider:'google',status:403})}}
function safeTranslationDetail(value:string){return value.replace(/\b(key|api_key|token|authorization)\s*=\s*[^\s&]+/gi,'$1=[redacted]').replace(/Bearer\s+[A-Za-z0-9._-]+/gi,'Bearer [redacted]').replace(/\s+/g,' ').trim().slice(0,300)}
let googleDisabledUntil=0;
const GOOGLE_TRANSLATE_URL='https://translation.googleapis.com/language/translate/v2';
const translationCache=new Map<string,{expires:number;value:string}>();
function translationHash(text:string){return createHash('sha256').update(text).digest('hex')}
function getCachedTranslation(key:string){const hit=translationCache.get(key);if(!hit)return null;if(hit.expires<=Date.now()){translationCache.delete(key);return null}return hit.value}
function setCachedTranslation(key:string,value:string){if(translationCache.size>=1000){const oldest=translationCache.keys().next().value;if(oldest)translationCache.delete(oldest)}translationCache.set(key,{value,expires:Date.now()+24*60*60_000})}
const AZURE_VOICES=[
 {id:'en-US-Ava:DragonHDLatestNeural',name:'Ava · natural HD',language:'en',locale:'en-US',primary:'en-US',gender:'Female',expressive:true},
 {id:'en-US-Andrew:DragonHDLatestNeural',name:'Andrew · natural HD',language:'en',locale:'en-US',primary:'en-US',gender:'Male',expressive:true},
 {id:'ta-IN-VaniNeural',name:'Vani · Tamil',language:'ta',locale:'ta-IN',primary:'ta-IN',gender:'Female',expressive:false},
 {id:'ta-IN-ValluvarNeural',name:'Valluvar · Tamil',language:'ta',locale:'ta-IN',primary:'ta-IN',gender:'Male',expressive:false},
 {id:'hi-IN-SwaraNeural',name:'Swara · Hindi',language:'hi',locale:'hi-IN',primary:'hi-IN',gender:'Female',expressive:false},
 {id:'hi-IN-MadhurNeural',name:'Madhur · Hindi',language:'hi',locale:'hi-IN',primary:'hi-IN',gender:'Male',expressive:false},
 {id:'en-US-AvaMultilingualNeural',name:'Ava · multilingual narrator',language:'*',locale:'en-US',primary:'en-US',gender:'Female',expressive:false},
 {id:'en-US-AndrewMultilingualNeural',name:'Andrew · multilingual narrator',language:'*',locale:'en-US',primary:'en-US',gender:'Male',expressive:false}
] as const;
const AZURE_STYLES=new Set(['neutral','narration-relaxed','narration-professional','documentary-narration','gentle','calm','sad','cheerful','excited','curious','chat','hopeful','reflective','empathetic','friendly']);
function azureReady(){return !!(process.env.AZURE_SPEECH_KEY&&process.env.AZURE_SPEECH_REGION)}
function escapeXml(value:string){return value.replace(/[<>&"']/g,character=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[character]||character))}
function pacedSsmlText(value:string){return escapeXml(value).replace(/\n\s*\n+/g,'<break time="620ms"/>').replace(/([.!?।！？…])\s+/g,'$1<break time="340ms"/> ').replace(/([,;،，、:])\s+/g,'$1<break time="150ms"/> ').trim()}
function azureSsml(text:string,voice:typeof AZURE_VOICES[number],locale:string,style:string,degree:number,rate:number,pitch:number,volume:number){const primary=voice.primary,langOpen=locale.toLowerCase()===primary.toLowerCase()?'':`<lang xml:lang="${escapeXml(locale)}">`,langClose=langOpen?'</lang>':'',styleOpen=voice.expressive&&style&&style!=='neutral'?`<mstts:express-as style="${escapeXml(style)}" styledegree="${degree.toFixed(2)}">`:'',styleClose=styleOpen?'</mstts:express-as>':'',pitchPercent=`${pitch>=1?'+':''}${Math.round((pitch-1)*100)}%`;return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${escapeXml(primary)}"><voice name="${escapeXml(voice.id)}">${langOpen}${styleOpen}<prosody rate="${rate.toFixed(2)}" pitch="${pitchPercent}" volume="${Math.round(volume*100)}">${pacedSsmlText(text)}</prosody>${styleClose}${langClose}</voice></speak>`}
function translationBatches<T>(items:T[],length:(item:T)=>number,maxLength=4000,maxCount=64){const batches:T[][]=[];let batch:T[]=[],total=0;for(const item of items){const size=length(item);if(batch.length&&(total+size>maxLength||batch.length>=maxCount)){batches.push(batch);batch=[];total=0}batch.push(item);total+=size}if(batch.length)batches.push(batch);return batches}
async function googleTranslate(texts:string[],source:string,target:string):Promise<string[]>{
 const key=process.env.GOOGLE_TRANSLATE_API_KEY!;
 const results:string[]=new Array(texts.length).fill('');
 const pending:{index:number;text:string}[]=[];
 texts.forEach((text,index)=>{const cacheKey=`google:${source}:${target}:${translationHash(text)}`;const hit=getCachedTranslation(cacheKey);if(hit!==null)results[index]=hit;else pending.push({index,text})});
 for(const batch of translationBatches(pending,item=>item.text.length)){
   let translated:string[];
   try{
    const url=new URL(GOOGLE_TRANSLATE_URL);url.searchParams.set('key',key);
    const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({q:batch.map(item=>item.text),target,format:'text',...(source&&source!=='auto'?{source}:{})}),signal:AbortSignal.timeout(20000)});
    if(!response.ok){
     const detail=safeTranslationDetail(await response.text().catch(()=>''));
     console.error('Translation provider error',JSON.stringify({provider:'google',status:response.status,detail:detail||null}));
     if(response.status===401||response.status===403)throw new GooglePermissionError('Google Translate could not use this API key. Enable the Cloud Translation API for translate.googleapis.com, then restart the API.');
     throw new TranslationError(`Google Translate returned HTTP ${response.status}${detail?`: ${detail}`:''}.`,{code:`GOOGLE_HTTP_${response.status}`,provider:'google',status:response.status});
    }
    const payload=await response.json() as {data?:{translations?:{translatedText:string}[]}};
    translated=payload.data?.translations?.map(item=>item.translatedText)||[];
   }catch(error){if(error instanceof TranslationError)throw error;const detail=safeTranslationDetail(error instanceof Error?error.message:'unknown error');console.error('Translation provider error',JSON.stringify({provider:'google',transport:true,detail:detail||null}));throw new TranslationError(`Google Translate could not be reached${detail?`: ${detail}`:''}.`,{code:'GOOGLE_TRANSPORT',provider:'google'})}
  if(translated.length!==batch.length)throw new TranslationError('Google Translate returned an incomplete response. Please retry.');
  batch.forEach((item,index)=>{const value=translated[index];results[item.index]=value;setCachedTranslation(`google:${source}:${target}:${translationHash(item.text)}`,value)});
 }
 return results;
}
async function translateBatch(texts:string[],source:string,target:string):Promise<{translations:string[];label:string;notice?:string}>{
 if(process.env.GOOGLE_TRANSLATE_API_KEY&&Date.now()>=googleDisabledUntil){
  try{return {translations:await googleTranslate(texts,source,target),label:'Google Translate'}}
  catch(error){if(!(error instanceof GooglePermissionError))throw error;googleDisabledUntil=Date.now()+10*60_000;console.warn('Google Translate key is not authorized; using the fallback translator for 10 minutes.')}
 }
  const url=process.env.LIBRETRANSLATE_URL;
  const localWorkerInstalled=existsSync(resolve(process.cwd(),'.venv/bin/python'));
  const translations:string[]=[];
  for(const text of texts){
   const cacheKey=`provider:${source}:${target}:${translationHash(text)}`;const hit=getCachedTranslation(cacheKey);if(hit!==null){translations.push(hit);continue}
   let value:string;
   if(url){
    try{
     const response=await fetch(`${url.replace(/\/$/,'')}/translate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({q:text,source:source||'auto',target,format:'text',api_key:process.env.LIBRETRANSLATE_API_KEY||undefined}),signal:AbortSignal.timeout(30000)});
     if(!response.ok){const detail=safeTranslationDetail(await response.text().catch(()=>''));console.error('Translation provider error',JSON.stringify({provider:'libretranslate',status:response.status,detail:detail||null}));throw new TranslationError(`LibreTranslate returned HTTP ${response.status}${detail?`: ${detail}`:''}.`,{code:`LIBRE_HTTP_${response.status}`,provider:'libretranslate',status:response.status})}
     const data=await response.json() as {translatedText:string};value=data.translatedText;
    }catch(error){if(error instanceof TranslationError)throw error;const detail=safeTranslationDetail(error instanceof Error?error.message:'unknown error');console.error('Translation provider error',JSON.stringify({provider:'libretranslate',transport:true,detail:detail||null}));throw new TranslationError(`LibreTranslate could not be reached${detail?`: ${detail}`:''}.`,{code:'LIBRE_TRANSPORT',provider:'libretranslate'})}
   }else{
    if(!localWorkerInstalled)throw new TranslationError('Translation is not configured on this server. Ask the admin to set GOOGLE_TRANSLATE_API_KEY or LIBRETRANSLATE_URL.',{code:'TRANSLATION_NOT_CONFIGURED',provider:'none'});
    value=await translateLocally(text,source||'auto',target);
   }
   if(typeof value!=='string'||!value)throw new TranslationError('Translation returned an empty response. Please retry.',{code:'TRANSLATION_EMPTY',provider:url?'libretranslate':'local'});
   setCachedTranslation(cacheKey,value);translations.push(value);
  }
   return {translations,label:url?'Machine translation':localWorkerInstalled?'On-device machine translation':'Translation service unavailable',notice:process.env.GOOGLE_TRANSLATE_API_KEY?'Google Translate is not enabled for this key. Used the app translator instead; enable translate.googleapis.com to use Google.':undefined};
}
function runVoiceCommand(command:string,args:string[]){return new Promise<void>((resolvePromise,rejectPromise)=>{const child=spawn(command,args,{stdio:'ignore'});const timer=setTimeout(()=>{child.kill('SIGKILL');rejectPromise(new Error('Voice generation took too long.'))},15000);child.once('error',error=>{clearTimeout(timer);rejectPromise(error)});child.once('close',code=>{clearTimeout(timer);if(code===0)resolvePromise();else rejectPromise(new Error(`${command} could not create the requested voice audio.`))})})}
async function polite(a:typeof adapters[number]){const last=sourceLastRequest.get(a.id)||0;const wait=Math.max(0,900-(Date.now()-last));if(wait)await new Promise(r=>setTimeout(r,wait));sourceLastRequest.set(a.id,Date.now());}
async function cachedSearch(a:typeof adapters[number],q:string,lang:string|undefined,page:number){const key=[a.id,q.toLocaleLowerCase(),lang||'',page].join('|');const hit=searchCache.get(key);if(hit&&hit.expires>Date.now())return hit.value;let job=inFlight.get(key);if(!job){job=polite(a).then(()=>a.search(q,lang,page)).then(value=>{searchCache.set(key,{expires:Date.now()+5*60_000,value});return value}).finally(()=>inFlight.delete(key));inFlight.set(key,job)}return job;}
app.set('trust proxy',1);
app.use(helmet());
const defaultCorsOrigins=['http://localhost:5173','http://localhost','https://localhost','capacitor://localhost','http://localhost:4000','https://book-for-aslin.vercel.app'];
const configuredCorsOrigins=(process.env.CORS_ORIGIN||'').split(',').map(s=>s.trim().replace(/\/$/,'')).filter(s=>s&&s!=='*');
const allowedCorsOrigins=new Set([...defaultCorsOrigins,...configuredCorsOrigins]);
app.use(cors({origin:(origin,callback)=>{
  if(!origin)return callback(null,true);
  const normalized=origin.replace(/\/$/,'');
  if(allowedCorsOrigins.has(normalized)||/^https:\/\/book-for-aslin[a-z0-9-]*\.vercel\.app$/i.test(normalized))return callback(null,true);
  return callback(null,false);
},credentials:true}));
app.use(express.json({limit:'1mb'}));
const sessionStore=new PrismaSessionStore();
app.use(session({store:sessionStore,name:'foryou.sid',secret:process.env.SESSION_SECRET,resave:false,saveUninitialized:false,rolling:true,cookie:{httpOnly:true,sameSite:process.env.COOKIE_SECURE==='true'?'none':'lax',secure:process.env.COOKIE_SECURE==='true',maxAge:1000*60*60*24*365}}));
app.use('/api/auth/login',rateLimit({windowMs:15*60*1000,limit:10,standardHeaders:true,legacyHeaders:false}));
declare module 'express-session'{interface SessionData{userId?:string;role?:string}}
type AuthContext={userId:string;role:string};
type BearerRequest=Request&{bearerAuth?:AuthContext};
function bearerToken(req:Request){const value=req.headers.authorization;const match=typeof value==='string'?/^Bearer\s+([A-Za-z0-9_-]{10,200})$/i.exec(value):null;return match?.[1]||''}
function authContext(req:Request):AuthContext|undefined{const bearer=(req as BearerRequest).bearerAuth;if(bearer)return bearer;return req.session.userId?{userId:req.session.userId,role:req.session.role||'MEMBER'}:undefined}
function currentUserId(req:Request){return authContext(req)!.userId}
app.use((req,res,next)=>{const token=bearerToken(req);if(!token||authContext(req))return next();sessionStore.get(token,(error,session)=>{if(!error&&session?.userId)(req as BearerRequest).bearerAuth={userId:session.userId,role:session.role||'MEMBER'};next()})});
const fail=(res:Response,status:number,message:string)=>res.status(status).json({error:message});
const pathParam=(value:string|string[]|undefined):string=>Array.isArray(value)?value[0]||'':value||'';
const BOOK_TEXT_CACHE_PREFIX='book-text:v1:';
const BOOK_TEXT_CACHE_TTL=30*24*60*60_000;
function hasBookTextContent(value:any){if(!value)return false;if(typeof value.text==='string')return !!value.text.trim();if(typeof value.html==='string')return !!value.html.trim();return false}
async function readBookTextCache<T>(key:string,allowExpired=false){try{const row=await prisma.apiCache.findUnique({where:{key}});if(!row)return null;const expired=row.expiresAt.getTime()<=Date.now();if(expired&&!allowExpired){await prisma.apiCache.deleteMany({where:{key}}).catch(()=>{});return null}const value=JSON.parse(row.value) as T;return hasBookTextContent(value)?value:null}catch{return null}}
async function writeBookTextCache(key:string,value:unknown){if(!hasBookTextContent(value))return;try{const record={value:JSON.stringify(value),expiresAt:new Date(Date.now()+BOOK_TEXT_CACHE_TTL)};await prisma.apiCache.upsert({where:{key},create:{key,...record},update:record})}catch{}}
const bookTextInFlight=new Map<string,Promise<unknown>>();
async function cachedBookText<T>(id:string,loader:()=>Promise<T|null>):Promise<T|null>{
 const key=BOOK_TEXT_CACHE_PREFIX+id,running=bookTextInFlight.get(key) as Promise<T|null>|undefined;
 if(running)return running;
 const task=(async()=>{const fresh=await readBookTextCache<T>(key);if(fresh)return fresh;try{const value=await loader();await writeBookTextCache(key,value);return value}catch(error){const stale=await readBookTextCache<T>(key,true);if(stale){const info=error instanceof BookFetchError?{type:error.code,host:error.meta.host,status:error.meta.status||null}:{type:error instanceof Error?error.name:'unknown',host:null,status:null};console.warn('Serving stale book text cache',JSON.stringify({bookId:id,...info}));return stale}throw error}})();
 bookTextInFlight.set(key,task);
 try{return await task}finally{bookTextInFlight.delete(key)}
}
function bookTextError(error:unknown){if(error instanceof BookFetchError){if(error.code==='blocked')return {status:502,message:'The source blocked the text download. Please open the book on the source website.'};if(error.code==='too-large')return {status:413,message:'The source text is too large for the in-app reader. Please use the original source.'};if(error.code==='redirect')return {status:502,message:'The source redirect could not be completed. Please retry.'};if(error.code==='dns')return {status:502,message:'The source could not be reached. Please retry later.'};if(error.code==='timeout')return {status:504,message:'The source took too long to respond. Please retry.'};if(error.code==='content-type')return {status:502,message:'The source did not return readable text.'};if(error.code==='empty')return {status:404,message:'No readable text is available for this page yet.'}}return {status:502,message:'Could not download readable text from this source right now.'}}
const appUpdateDir=resolve(process.cwd(),'data/updates');const MAX_UPDATE_BYTES=150*1024*1024;
function updateHost(value:string){try{return new URL(value).host}catch{return'invalid-host'}}
async function auth(req:Request,res:Response,next:NextFunction){const context=authContext(req);if(!context)return fail(res,401,'Please sign in to continue.');const user=await prisma.user.findUnique({where:{id:context.userId},select:{active:true}});if(!user?.active){if(!bearerToken(req))req.session.destroy(()=>{});return fail(res,401,'This account is inactive.');}next()}
function admin(req:Request,res:Response,next:NextFunction){if(authContext(req)?.role!=='ADMIN')return fail(res,403,'Admin access required.');next()}
const bookSchema=z.object({id:z.string(),source:z.string(),sourceUrl:z.string().url(),title:z.string(),authors:z.string(),description:z.string().optional(),coverUrl:z.string().url().optional(),language:z.string(),year:z.number().optional(),license:z.string(),rightsBasis:z.string(),countryRestrictions:z.string(),attribution:z.string(),formats:z.array(z.object({type:z.string(),url:z.string().url()})),categories:z.array(z.string()).optional()});
async function persistBook(raw:Book){const b=bookSchema.parse(raw);return prisma.book.upsert({where:{id:b.id},create:{...b,formats:JSON.stringify(b.formats),categories:JSON.stringify(b.categories||['Other'])},update:{title:b.title,authors:b.authors,description:b.description,coverUrl:b.coverUrl,formats:JSON.stringify(b.formats),categories:JSON.stringify(b.categories||['Other'])}})}
async function catalogBookDetails(id:string):Promise<Book|null>{if(id.startsWith('opentextbook:'))return openTextbooks.getDetails(id);for(const adapter of adapters){if(id.startsWith(`${adapter.id}:`)||id.startsWith('gutenberg:')||id.startsWith('wikisource:')){try{const book=await adapter.getDetails(id);if(book)return book}catch{return null}}}return null}
function mergeCatalogBooks(books:Book[]){const normalize=(value:string)=>value.toLocaleLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim();const merged=new Map<string,Book>();for(const book of books){const key=[normalize(book.title),normalize(book.authors),book.language].join('|');const current=merged.get(key);if(!current){merged.set(key,book);continue;}merged.set(key,{...current,year:current.year??book.year,coverUrl:current.coverUrl||book.coverUrl,categories:[...new Set([...(current.categories||[]),...(book.categories||[])])]});}return [...merged.values()];}
const polyglotGuide:Book={id:'openlibrary:OL17006655W:willyouspeakengl00stra',source:'Open Library · Internet Archive',sourceUrl:'https://www.loc.gov/item/10029478/',title:'Will You Speak English? German? French? Italian? Spanish? and Portuguese?',authors:'J. Strause',language:'en',year:1870,license:'Public domain · Library of Congress',rightsBasis:'The Library of Congress identifies this digitized 1870 book as public domain and free to use and reuse.',countryRestrictions:'Copyright rules can vary by country; check local requirements.',attribution:'J. Strause, polyglot pocket manual (1870). Library of Congress; digitized reading copy via Internet Archive.',formats:[{type:'HTML',url:'https://archive.org/stream/willyouspeakengl00stra?ui=embed'}],categories:['Language Learning','Conversation & Phrase Books']};
const locLanguageGuide=(id:string,title:string,authors:string,year:number,target:string):Book=>({id:'loc:'+id,source:'Library of Congress · Public Domain',sourceUrl:'https://www.loc.gov/item/'+id+'/',title,authors,language:'en',year,license:'Public domain · Library of Congress',rightsBasis:'The Library of Congress identifies this digitized book as public domain and free to use and reuse.',countryRestrictions:'Copyright rules can vary by country; check local requirements.',attribution:'Digitized book and rights statement: Library of Congress.',formats:[{type:'PDF',url:'https://www.loc.gov/item/'+id+'/?fo=pdf'}],categories:['Language Learning',target+' Language']});
const languageLearningBooks:Book[]=[polyglotGuide,locLanguageGuide('22025279',"Ollendorff’s New Method of Learning to Read, Write, and Speak the German Language",'H. G. Ollendorff; edited by G. J. Adler',1850,'German'),locLanguageGuide('12008615','The Rudiments of the Chinese Language: With Dialogues, Exercises, and a Vocabulary','James Summers',1864,'Chinese'),locLanguageGuide('52061698','Oral Drill Text, Based on Naganuma Primer','U.S. Army Language School',1951,'Japanese'),locLanguageGuide('05032873','El manual de hablar y pronunciar del Dr. Rosenthal','Richard S. Rosenthal',1905,'French'),locLanguageGuide('01026057','Los primeros pasos en castellano','Manuel Fernández Juncos; Albert LeRoy Bartlett',1901,'Spanish'),locLanguageGuide('21020755',"The Beginner’s English Book for the Use of Adult Students",'Mary E. Nolin',1921,'English'),locLanguageGuide('10027989','Letture accompagnate da esercizj di lingua e di grammatica','Austrian Ministry of Education',1869,'Italian'),locLanguageGuide('57061065','Dialogue in Spoken Arabic','U.S. Army Language School',1957,'Arabic')];
app.get('/api/app/update',async(_req,res)=>{try{const file=resolve(appUpdateDir,'latest.json');const [raw,info]=await Promise.all([readFile(file,'utf8'),stat(file)]);const release=JSON.parse(raw);const publishedAt=typeof release.publishedAt==='string'&&!Number.isNaN(Date.parse(release.publishedAt))?release.publishedAt:info.mtime.toISOString();res.set('Cache-Control','no-store').json({...release,publishedAt})}catch{return fail(res,404,'No app update is published yet.')}});
app.get('/api/app/update.apk',async(_req,res)=>{
 const source=process.env.APP_UPDATE_APK_URL;
 if(!source)return fail(res,404,'No app update package is published yet.');
 try{
  const headers:Record<string,string>={Accept:'application/vnd.android.package-archive'};
  if(process.env.APP_UPDATE_TOKEN)headers.Authorization=`Bearer ${process.env.APP_UPDATE_TOKEN}`;
  const upstream=await fetch(source,{headers,redirect:'follow',signal:AbortSignal.timeout(120000)});
  if(!upstream.ok){console.error('App update download failed',JSON.stringify({status:upstream.status,host:updateHost(source)}));return fail(res,502,'The update package could not be fetched.')}
  const declared=Number(upstream.headers.get('content-length')||0);
  if(Number.isFinite(declared)&&declared>MAX_UPDATE_BYTES)return fail(res,413,'The update package is too large.');
  if(!upstream.body)return fail(res,502,'The update package is empty.');
  let total=0;
  const limiter=new Transform({transform(chunk:Buffer,_encoding,callback){total+=chunk.length;if(total>MAX_UPDATE_BYTES){callback(new Error('update package too large'));return}callback(null,chunk)}});
  res.set('Cache-Control','no-store').type('application/vnd.android.package-archive');
  if(Number.isFinite(declared)&&declared>0)res.set('Content-Length',String(declared));
  await pipeline(Readable.fromWeb(upstream.body as any),limiter,res);
 }catch(error){
  console.error('App update proxy failed',JSON.stringify({message:error instanceof Error?error.message.slice(0,200):'unknown',host:updateHost(source)}));
  if(!res.headersSent)fail(res,502,'The update package could not be fetched.');
 }
});
app.get('/api/health',async(_req,res)=>{
  let database=false;
  try{await prisma.$queryRaw`SELECT 1`;database=true}catch(error){console.error('Health check database probe failed:',error)}
  const sources=await Promise.all(adapters.map(async a=>{try{return {source:a.id,healthy:await a.health()}}catch{return {source:a.id,healthy:false}}}));
  const translation={googleConfigured:!!process.env.GOOGLE_TRANSLATE_API_KEY,libreConfigured:!!process.env.LIBRETRANSLATE_URL,localWorkerInstalled:existsSync(resolve(process.cwd(),'.venv/bin/python'))};
  res.status(200).json({ok:database,database,sources,translation,service:'for-you-books-api'});
 });
app.post('/api/auth/login',async(req,res)=>{const parsed=z.object({email:z.string().email(),password:z.string().min(1)}).safeParse(req.body);if(!parsed.success)return fail(res,400,'Enter a valid email and password.');const user=await prisma.user.findUnique({where:{email:parsed.data.email.toLowerCase()}});if(!user?.active||!await argon2.verify(user.passwordHash,parsed.data.password))return fail(res,401,'Email or password is incorrect.');req.session.userId=user.id;req.session.role=user.role;res.json({id:user.id,email:user.email,role:user.role,token:req.session.id})});
app.post('/api/auth/logout',auth,(req,res)=>{const token=bearerToken(req);if(token)return sessionStore.destroy(token,()=>res.json({ok:true}));req.session.destroy(()=>res.json({ok:true}))});app.get('/api/auth/me',(req,res)=>{const context=authContext(req);if(!context)return res.json(null);prisma.user.findUnique({where:{id:context.userId},select:{id:true,email:true,role:true}}).then(u=>res.json(u))});
app.get('/api/books/search',auth,async(req,res)=>{const q=z.string().trim().min(1).max(200).safeParse(req.query.q);if(!q.success)return fail(res,400,'Enter a title, author, subject, or keyword.');const language=typeof req.query.language==='string'?req.query.language:undefined;const page=Math.max(1,Number(req.query.page||1));const searchAdapters=adapters.filter(a=>a.id!=='projectmadurai'||language==='ta'||/[\u0B80-\u0BFF]/u.test(q.data));const settled=await Promise.allSettled(searchAdapters.map(a=>cachedSearch(a,q.data,language,page)));const books=settled.flatMap(x=>x.status==='fulfilled'?x.value.books:[]);const result=mergeCatalogBooks(books);const openLibraryIndex=searchAdapters.findIndex(a=>a.id==='openlibrary');const openLibraryResult=settled[openLibraryIndex];const catalogTotal=openLibraryResult?.status==='fulfilled'?openLibraryResult.value.total:undefined;res.json({results:result,total:result.length,catalogTotal,page,hasMore:settled.some(x=>x.status==='fulfilled'&&!!x.value.next),partial: settled.some(x=>x.status==='rejected'),unavailableSources:settled.flatMap((x,i)=>x.status==='rejected'?[searchAdapters[i].id]:[])})});
app.get('/api/books/discover',auth,async(req,res)=>{if(req.query.learner==='1')return res.json({results:languageLearningBooks,total:languageLearningBooks.length,catalogTotal:languageLearningBooks.length,page:1,hasMore:false,partial:false});const language=typeof req.query.language==='string'?req.query.language:'all';const page=Math.max(1,Number(req.query.page||1));const topic=typeof req.query.topic==='string'?req.query.topic:'';const sort=req.query.sort==='old'?'old':'new';const allowed=['world','education','history','geography','astronomy','nature','culture','travel','science','philosophy','general-knowledge','comics-cartoon','comedy-humor','mystery','romance','fiction','story-books','biography','poetry','religion','children','brain-mind','bible','tamil-nadu'];if(topic&&!allowed.includes(topic))return fail(res,400,'Choose a listed subject.');try{const selectedLanguage=language==='ta'||topic==='tamil-nadu'?'ta':language;const requests:Promise<{books:Book[];total?:number;next?:string|null}>[]=[gutenberg.discover(selectedLanguage,page,topic),openLibrary.discover(selectedLanguage,page,topic,sort)];if(topic==='education')requests.push(openTextbooks.discover(page));if(selectedLanguage==='ta')requests.push(projectMadurai.search('', 'ta', page));const settled=await Promise.allSettled(requests);const books=mergeCatalogBooks(settled.flatMap(x=>x.status==='fulfilled'?x.value.books:[]));books.sort((a,b)=>{if(a.year===undefined)return 1;if(b.year===undefined)return -1;return sort==='old'?a.year-b.year:b.year-a.year});if(language==='all'&&!topic&&page===1)books.unshift(polyglotGuide);res.json({results:books,total:books.length,catalogTotal:(settled[1]?.status==='fulfilled'?(settled[1].value.total||0):0)+(topic==='education'&&settled[2]?.status==='fulfilled'?(settled[2].value.total||0):0),page,hasMore:settled.some(x=>x.status==='fulfilled'&&!!x.value.next),partial:settled.some(x=>x.status==='rejected')})}catch{return fail(res,502,'The book catalog is temporarily unavailable. Please try again.')}});
app.get('/api/books/:id',auth,async(req,res)=>{const id=decodeURIComponent(pathParam(req.params.id));const book=await catalogBookDetails(id);if(book){await persistBook(book).catch(()=>null);return res.json(book)}const found=await prisma.book.findUnique({where:{id}});return found?res.json({...found,formats:JSON.parse(found.formats),categories:JSON.parse(found.categories)}):fail(res,404,'This book has no free legal copy yet.')});
app.get('/api/books/:id/content',auth,async(req,res)=>{
 const id=decodeURIComponent(pathParam(req.params.id));
 try{
  if(id.startsWith('openlibrary:')){
   const archiveId=id.split(':').at(-1)||'';
   if(!/^[A-Za-z0-9._-]+$/.test(archiveId))return fail(res,400,'Invalid book identifier.');
   const content=await cachedBookText(id,async()=>{const response=await fetchBookText(`https://archive.org/download/${encodeURIComponent(archiveId)}/${encodeURIComponent(archiveId)}_djvu.txt`,{label:`openlibrary:${archiveId}`,accept:'text/plain,*/*;q=0.8',maxBytes:8*1024*1024});const text=response.value.trim();return text?{text:text.slice(0,1000000)}:null});
   return content?res.json(content):fail(res,404,'The source does not provide downloadable text for this book.');
  }
  if(!id.startsWith('wikisource:')&&!id.startsWith('projectmadurai:'))return fail(res,400,'This source must be read from its official page.');
  const content=await cachedBookText(id,()=>id.startsWith('projectmadurai:')?getProjectMaduraiText(id):getWikisourceText(id));
  if(!content)console.warn('Book text extractor returned no content',JSON.stringify({bookId:id}));
  return content?res.json(content):fail(res,404,'No readable text is available for this page yet.');
 }catch(error){const detail=bookTextError(error);console.error('Book text download failed',JSON.stringify({bookId:id,type:error instanceof BookFetchError?error.code:error instanceof Error?error.name:'unknown',host:error instanceof BookFetchError?error.meta.host:null,status:error instanceof BookFetchError?error.meta.status||null:null,message:error instanceof Error?error.message.slice(0,300):'unknown'}));return fail(res,detail.status,detail.message)}
});
app.get('/api/books/:id/pdf',auth,async(req,res)=>{try{const id=decodeURIComponent(pathParam(req.params.id));const book=await catalogBookDetails(id);const pdf=book?.formats.find(format=>format.type==='PDF');if(!pdf)return fail(res,404,'A downloadable PDF is not available for this book.');const url=new URL(pdf.url);if(url.protocol!=='https:')return fail(res,400,'Only secure PDF sources are supported.');const response=await fetchBookBuffer(url.toString(),{label:`pdf:${id}`,accept:'application/pdf,*/*;q=0.8',maxBytes:50*1024*1024,expected:/pdf|octet-stream/i});const bytes=response.value;if(bytes.length>50*1024*1024)return fail(res,413,'This PDF is too large to translate in the reader.');if(!bytes.subarray(0,5).toString().startsWith('%PDF-'))return fail(res,502,'The source did not return a readable PDF.');res.set('Cache-Control','private, max-age=300').type('application/pdf').send(bytes)}catch(error){console.error('Book PDF download failed',JSON.stringify({type:error instanceof BookFetchError?error.code:error instanceof Error?error.name:'unknown',host:error instanceof BookFetchError?error.meta.host:null,status:error instanceof BookFetchError?error.meta.status||null:null,message:error instanceof Error?error.message.slice(0,300):'unknown'}));return fail(res,502,'The book PDF could not be downloaded from its source. Please retry.')}});
app.get('/api/books/:id/epub',auth,async(req,res)=>{
 const id=decodeURIComponent(pathParam(req.params.id));
 if(!/^gutenberg:\d+$/.test(id))return fail(res,400,'This EPUB is not available.');
 const bookId=id.slice('gutenberg:'.length),folder=resolve(process.cwd(),'data','books'),file=resolve(folder,`${bookId}.epub`);
 try{
  let bytes:Buffer|undefined;
  try{const cached=await readFile(file);if(cached[0]===0x50&&cached[1]===0x4b)bytes=cached}catch{}
  if(!bytes){
   let formats:Format[]=[];
   const stored=await prisma.book.findUnique({where:{id},select:{formats:true}});
   if(stored)try{formats=JSON.parse(stored.formats) as Format[]}catch{}
   let format=formats.find(item=>item.type==='EPUB');
   if(!format){const book=await gutenberg.getDetails(id);format=book?.formats.find(item=>item.type==='EPUB');}
   if(!format)return fail(res,404,'An EPUB edition is not available for this book.');
        const response=await fetchGutenbergEpub(id,format.url,{label:`epub:${id}`,accept:'application/epub+zip,application/zip,*/*;q=0.8',maxBytes:80*1024*1024,expected:/epub|zip|octet-stream/i});
   const data=response.value;
   if(data.length>80*1024*1024)throw new Error('Book file is too large.');
   if(data[0]!==0x50||data[1]!==0x4b)throw new Error('The downloaded response is not an EPUB ZIP file.');
   await mkdir(folder,{recursive:true});await writeFile(file,data);bytes=data;
  }
  res.setHeader('Content-Length',String(bytes.length));res.setHeader('Content-Type','application/epub+zip');res.setHeader('Cache-Control','private, max-age=3600');res.setHeader('Content-Disposition',`inline; filename="${bookId}.epub"`);res.send(bytes);
 }catch(error){console.error('EPUB reader download failed',JSON.stringify({type:error instanceof BookFetchError?error.code:error instanceof Error?error.name:'unknown',host:error instanceof BookFetchError?error.meta.host:null,status:error instanceof BookFetchError?error.meta.status||null:null,message:error instanceof Error?error.message.slice(0,300):'unknown'}));fail(res,502,'The book did not finish loading from its source. Please retry.')}
});
app.get('/api/library',auth,async(req,res)=>{const uid=currentUserId(req);const [favorites,saved,progress]=await Promise.all([prisma.favorite.findMany({where:{userId:uid},include:{book:true}}),prisma.savedBook.findMany({where:{userId:uid},include:{book:true}}),prisma.readingProgress.findMany({where:{userId:uid},include:{book:true},orderBy:{updatedAt:'desc'}})]);res.json({favorites,saved,progress})});
app.put('/api/library/:bookId/:kind',auth,async(req,res)=>{const uid=currentUserId(req),bookId=decodeURIComponent(pathParam(req.params.bookId)),kind=pathParam(req.params.kind);if(kind!=='favorite'&&kind!=='saved')return fail(res,400,'Unknown library action.');try{const existing=await prisma.book.findUnique({where:{id:bookId},select:{id:true}});if(!existing){const book=await catalogBookDetails(bookId);if(!book)return fail(res,404,'This book is no longer available from its source.');await persistBook(book)}if(kind==='favorite')await prisma.favorite.upsert({where:{userId_bookId:{userId:uid,bookId}},create:{userId:uid,bookId},update:{}});else await prisma.savedBook.upsert({where:{userId_bookId:{userId:uid,bookId}},create:{userId:uid,bookId},update:{}});res.json({ok:true})}catch(error){console.error('Could not save book to library:',error);return fail(res,500,'Could not save this book right now. Please retry.')}});
app.delete('/api/library/:bookId/:kind',auth,async(req,res)=>{const uid=currentUserId(req),bookId=decodeURIComponent(pathParam(req.params.bookId));if(pathParam(req.params.kind)==='favorite')await prisma.favorite.deleteMany({where:{userId:uid,bookId}});else await prisma.savedBook.deleteMany({where:{userId:uid,bookId}});res.json({ok:true})});
app.put('/api/progress/:bookId',auth,async(req,res)=>{const locator=z.string().max(10000).safeParse(req.body.locator);if(!locator.success)return fail(res,400,'Invalid reading position.');const bookId=decodeURIComponent(pathParam(req.params.bookId)),uid=currentUserId(req);try{await prisma.readingProgress.upsert({where:{userId_bookId:{userId:uid,bookId}},create:{userId:uid,bookId,locator:locator.data},update:{locator:locator.data}});res.json({ok:true})}catch{return fail(res,404,'Book not found.')}});
app.get('/api/bookmarks/:bookId',auth,async(req,res)=>res.json(await prisma.bookmark.findMany({where:{userId:currentUserId(req),bookId:decodeURIComponent(pathParam(req.params.bookId))}})));
app.post('/api/bookmarks/:bookId',auth,async(req,res)=>{const s=z.object({locator:z.string().max(10000),label:z.string().max(255).optional()}).safeParse(req.body);if(!s.success)return fail(res,400,'Invalid bookmark.');try{res.json(await prisma.bookmark.create({data:{...s.data,userId:currentUserId(req),bookId:decodeURIComponent(pathParam(req.params.bookId))}}))}catch{return fail(res,404,'Book not found.')}});
app.delete('/api/bookmarks/:bookId/:bookmarkId',auth,async(req,res)=>{const userId=currentUserId(req),bookId=decodeURIComponent(pathParam(req.params.bookId)),bookmarkId=pathParam(req.params.bookmarkId);const removed=await prisma.bookmark.deleteMany({where:{id:bookmarkId,userId,bookId}});if(!removed.count)return fail(res,404,'Bookmark not found.');res.json({ok:true})});
app.get('/api/settings',auth,async(req,res)=>res.json(await prisma.userSettings.upsert({where:{userId:currentUserId(req)},create:{userId:currentUserId(req)},update:{}})));
app.put('/api/settings',auth,async(req,res)=>{const s=z.object({theme:z.enum(['light','dark','sepia']),fontSize:z.number().int().min(14).max(32),readingLanguage:z.string().max(20),translationLanguage:z.string().max(20)}).safeParse(req.body);if(!s.success)return fail(res,400,'Invalid preferences.');res.json(await prisma.userSettings.upsert({where:{userId:currentUserId(req)},create:{...s.data,userId:currentUserId(req)},update:s.data}))});
app.post('/api/translate',auth,async(req,res)=>{
 const s=z.object({text:z.string().min(1).max(4000).optional(),texts:z.array(z.string().min(1).max(4000)).min(1).max(64).optional(),source:z.string().max(32).optional(),target:z.string().min(2).max(12)}).refine(value=>!!value.text||!!value.texts,{message:'Choose text to translate.'}).safeParse(req.body);
 if(!s.success)return fail(res,400,'Choose a short passage to translate.');
  const texts=s.data.texts||[s.data.text!],source=s.data.source||'auto',requestId=`tr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
  try{const {translations,label,notice}=await translateBatch(texts,source,s.data.target);res.json({translation:translations[0],translations,label,notice})}
  catch(error){
   const failure=error instanceof TranslationError?error:new TranslationError(error instanceof Error?error.message:'Translation is unavailable right now.');
   const details={requestId,provider:failure.provider,code:failure.code,status:failure.status??null};
   console.error('Translation failed',JSON.stringify({...details,textCount:texts.length,source,target:s.data.target,message:failure.message.slice(0,300)}));
   res.status(503).json({error:failure.message,details});
  }
});
app.get('/api/voice-config',auth,(_req,res)=>res.json({provider:azureReady()?'azure':'device',voices:azureReady()?AZURE_VOICES.map(({id,name,language,locale,gender})=>({id,name,language,locale,gender,provider:'azure'})):[],message:azureReady()?'Expressive neural narration is ready.':'Add AZURE_SPEECH_KEY and AZURE_SPEECH_REGION to enable expressive neural narration.'}));
app.post('/api/speak-expressive',auth,async(req,res)=>{
 const s=z.object({text:z.string().min(1).max(1600),language:z.string().min(2).max(12),voice:z.string().max(120).refine(value=>AZURE_VOICES.some(item=>item.id===value)),locale:z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,4})?$/i),style:z.string().max(40).refine(value=>AZURE_STYLES.has(value)).optional(),degree:z.number().min(.01).max(2).optional(),rate:z.number().min(.5).max(2).optional(),pitch:z.number().min(.5).max(1.5).optional(),volume:z.number().min(.1).max(1).optional()}).safeParse(req.body);
 if(!s.success)return fail(res,400,'Choose a supported narration voice and passage.');
 if(!azureReady())return fail(res,501,'Expressive neural narration is not configured on this server.');
 const voice=AZURE_VOICES.find(item=>item.id===s.data.voice)!,region=process.env.AZURE_SPEECH_REGION!;
 try{
  const response=await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,{method:'POST',headers:{'Ocp-Apim-Subscription-Key':process.env.AZURE_SPEECH_KEY!,'Content-Type':'application/ssml+xml','X-Microsoft-OutputFormat':'audio-24khz-96kbitrate-mono-mp3','User-Agent':'ForYouBooks/1.0'},body:azureSsml(s.data.text,voice,s.data.locale,s.data.style||'neutral',s.data.degree??1,s.data.rate??1,s.data.pitch??1,s.data.volume??1),signal:AbortSignal.timeout(25000)});
  if(!response.ok){const detail=await response.text().catch(()=>'');console.error('Azure speech synthesis failed:',response.status,detail.slice(0,400));return fail(res,502,'The expressive voice could not be generated. Please retry or choose another voice.')}
  const audio=Buffer.from(await response.arrayBuffer());res.set('Cache-Control','no-store').type('audio/mpeg').send(audio)
 }catch(error){console.error('Azure speech request failed:',error);fail(res,503,'The expressive voice is unavailable right now. Please retry.')}
});
app.post('/api/speak',auth,async(req,res)=>{const s=z.object({text:z.string().min(1).max(1600),language:z.enum(['en','ta','hi'])}).safeParse(req.body);if(!s.success)return fail(res,400,'Choose English, Tamil, or Hindi and provide a short passage.');if(process.platform!=='darwin')return fail(res,501,'The native fallback voice is only available on macOS. Use the device reading voice instead.');const voice=({en:'Samantha',ta:'Vani',hi:'Lekha'} as const)[s.data.language],paced=s.data.text.replace(/\n\s*\n+/g,' [[slnc 520]] ').replace(/([.!?।！？…])\s+/g,'$1 [[slnc 320]] ').replace(/([,;،，、])\s+/g,'$1 [[slnc 160]] ').trim(),directory=await mkdtemp(join(tmpdir(),'foryou-voice-')),aiff=join(directory,'speech.aiff'),wav=join(directory,'speech.wav');try{await runVoiceCommand('say',['-v',voice,'-r','132','-o',aiff,paced]);await runVoiceCommand('afconvert',['-f','WAVE','-d','LEI16',aiff,wav]);const audio=await readFile(wav);res.set('Cache-Control','no-store').type('audio/wav').send(audio)}catch(error){return fail(res,503,`The ${s.data.language==='ta'?'Tamil':s.data.language==='hi'?'Hindi':'English'} voice could not be generated.`)}finally{await rm(directory,{recursive:true,force:true}).catch(()=>{})}});
app.get('/api/admin/members',auth,admin,async(_req,res)=>res.json(await prisma.user.findMany({select:{id:true,email:true,role:true,active:true,createdAt:true}})));
app.post('/api/admin/members',auth,admin,async(req,res)=>{const s=z.object({email:z.string().email(),password:z.string().min(12)}).safeParse(req.body);if(!s.success)return fail(res,400,'Use a valid email and a password of at least 12 characters.');try{const used=(await prisma.user.findMany({select:{accountSlot:true}})).map(u=>u.accountSlot);const slot=[1,2,3,4,5,6,7].find(n=>!used.includes(n));if(!slot)return fail(res,409,'The seven approved accounts are already in use.');const user=await prisma.user.create({data:{email:s.data.email.toLowerCase(),passwordHash:await argon2.hash(s.data.password),accountSlot:slot}});res.status(201).json({id:user.id,email:user.email})}catch{return fail(res,409,'That email is already registered.')}});
app.post('/api/admin/members/:id/reset-password',auth,admin,async(req,res)=>{const s=z.object({password:z.string().min(12)}).safeParse(req.body);if(!s.success)return fail(res,400,'Use a password of at least 12 characters.');try{await prisma.user.update({where:{id:pathParam(req.params.id)},data:{passwordHash:await argon2.hash(s.data.password)}});res.json({ok:true})}catch{return fail(res,404,'Member not found.')}});
app.patch('/api/admin/members/:id',auth,admin,async(req,res)=>{const active=z.boolean().safeParse(req.body.active);if(!active.success)return fail(res,400,'Invalid account status.');if(req.params.id===currentUserId(req)&&!active.data)return fail(res,400,'You cannot disable your own admin account.');res.json(await prisma.user.update({where:{id:pathParam(req.params.id)},data:{active:active.data}}))});
app.use((err:Error,_req:Request,res:Response,_next:NextFunction)=>{console.error(err);res.status(500).json({error:'Something went wrong. Please try again.'})});
app.listen(PORT,()=>{console.log(`FOR YOU API listening on :${PORT}`);console.log(`Translation provider: ${process.env.GOOGLE_TRANSLATE_API_KEY?'Google Translate v2':process.env.LIBRETRANSLATE_URL?'LibreTranslate':existsSync(resolve(process.cwd(),'.venv/bin/python'))?'local NLLB model':'not configured'}`);console.log('Translation configuration:',JSON.stringify({googleConfigured:!!process.env.GOOGLE_TRANSLATE_API_KEY,libreConfigured:!!process.env.LIBRETRANSLATE_URL,localWorkerInstalled:existsSync(resolve(process.cwd(),'.venv/bin/python'))}));console.log(`Voice provider: ${azureReady()?'Azure neural narration':'device voices + macOS fallback'}`);if(process.env.GOOGLE_TRANSLATE_API_KEY||process.env.LIBRETRANSLATE_URL||!existsSync(resolve(process.cwd(),'.venv/bin/python')))return;setTimeout(()=>{try{getLocalTranslationWorker().stdin.write(`${JSON.stringify({id:0,warmup:true})}\n`)}catch(error){console.warn('Could not warm the local translator:',error)}},500)});
