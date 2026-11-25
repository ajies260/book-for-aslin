import {PrismaClient} from '@prisma/client';
import {Book} from './adapters/types';
import {mapWork,openLibrary} from './adapters/openlibrary';
import {projectMadurai} from './adapters/projectmadurai';
import {fetchBookJson} from './book-fetch';

export type Shelf={slug:string;title:string;topic:string;language:string;books:Book[];stale:boolean};
type ShelfKind='trending'|'subject'|'tamil';
type ShelfConfig={slug:string;title:string;topic:string;language:string;kind:ShelfKind;endpoint?:string;subject?:string;fallbackTopic?:string};

const SHELF_TTL=12*60*60*1000;
const SHELF_CACHE_PREFIX='shelf:v1:';
const USER_AGENT='FOR-YOU-Books/1.0 (free public access catalog)';
const SHELF_CONFIGS:ShelfConfig[]=[
 {slug:'trending',title:'Trending',topic:'',language:'all',kind:'trending',endpoint:'https://openlibrary.org/trending/weekly.json?limit=20',fallbackTopic:''},
 {slug:'whats-new',title:"What's new",topic:'',language:'all',kind:'trending',endpoint:'https://openlibrary.org/trending/daily.json?limit=20',fallbackTopic:''},
 {slug:'classics',title:'Classics',topic:'fiction',language:'all',kind:'subject',subject:'classics',fallbackTopic:'fiction'},
 {slug:'fiction',title:'Fiction',topic:'fiction',language:'all',kind:'subject',subject:'fiction',fallbackTopic:'fiction'},
 {slug:'romance',title:'Romance',topic:'romance',language:'all',kind:'subject',subject:'romance',fallbackTopic:'romance'},
 {slug:'science',title:'Science',topic:'science',language:'all',kind:'subject',subject:'science',fallbackTopic:'science'},
 {slug:'history',title:'History',topic:'history',language:'all',kind:'subject',subject:'history',fallbackTopic:'history'},
 {slug:'tamil',title:'Tamil (Project Madurai)',topic:'tamil-nadu',language:'ta',kind:'tamil'},
 {slug:'kids',title:'Kids',topic:'children',language:'all',kind:'subject',subject:'juvenile fiction',fallbackTopic:'children'}
];

function sleep(ms:number){return new Promise<void>(resolve=>setTimeout(resolve,ms))}
function dedupe(books:Book[]){return [...new Map(books.filter(book=>!!book?.id).map(book=>[book.id,book])).values()]}
function mapShelfWork(work:any){return mapWork(work,{requireYear:false,requireArchive:false})}
async function readCache<T>(prisma:PrismaClient,key:string){try{const row=await prisma.apiCache.findUnique({where:{key}});if(!row)return null;return {value:JSON.parse(row.value) as T,fresh:row.expiresAt.getTime()>Date.now()}}catch{return null}}
async function writeCache(prisma:PrismaClient,key:string,value:unknown){try{const record={value:JSON.stringify(value),expiresAt:new Date(Date.now()+SHELF_TTL)};await prisma.apiCache.upsert({where:{key},create:{key,...record},update:record})}catch{}}
async function mapWithConcurrency<T,R>(items:T[],limit:number,worker:(item:T)=>Promise<R>){const results=new Array<R>(items.length);let next=0;async function run(){while(true){const index=next++;if(index>=items.length)return;results[index]=await worker(items[index]);await sleep(150)}}await Promise.all(Array.from({length:Math.min(limit,items.length)},run));return results}
async function fetchShelfBooks(config:ShelfConfig){
 let books:Book[]=[];
 if(config.kind==='tamil'){
  const result=await projectMadurai.search('','ta',1);
  books=dedupe(result.books);
 }else if(config.endpoint){
  const result=await fetchBookJson<{works?:any[]}>(config.endpoint,{headers:{'User-Agent':USER_AGENT},timeoutMs:15000});
  books=dedupe((result.value.works||[]).map(mapShelfWork).filter((book):book is Book=>!!book));
 }
 if(books.length<8&&config.fallbackTopic!==undefined){
  const fallback=await openLibrary.discover(config.language,1,config.fallbackTopic,'new');
  books=dedupe([...books,...fallback.books]);
 }
 return books.slice(0,20);
}
async function loadShelf(prisma:PrismaClient,config:ShelfConfig):Promise<Shelf>{
 const meta={slug:config.slug,title:config.title,topic:config.topic,language:config.language},key=`${SHELF_CACHE_PREFIX}${config.slug}`,cached=await readCache<Shelf>(prisma,key);
 if(cached?.fresh)return {...meta,...cached.value,stale:false};
 try{
  const shelf={...meta,books:await fetchShelfBooks(config),stale:false};
  await writeCache(prisma,key,shelf);
  return shelf;
 }catch{
  if(cached?.value)return {...meta,...cached.value,stale:true};
  return {...meta,books:[],stale:true};
 }
}
export async function loadShelves(prisma:PrismaClient){return mapWithConcurrency(SHELF_CONFIGS,3,config=>loadShelf(prisma,config))}
