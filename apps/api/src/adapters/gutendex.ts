import {Adapter,Book,Format} from './types';
import {BookFetchError,fetchBookBuffer,fetchBookJson,fetchBookText,DownloadOptions} from '../book-fetch';

const BASE='https://gutendex.com/books/';
const HEALTH_BOOK_ID='1342';
type Raw={id:number;title:string;authors:{name:string;birth_year:number|null;death_year:number|null}[];subjects:string[];languages:string[];copyright:boolean;media_type:string;formats:Record<string,string>; download_count:number};
const categoryRules:Record<string,RegExp>={Education:/education|textbook|teaching|pedagogy|school|curriculum|instruction|learning/i,Fiction:/fiction|novel|short stor/i,Poetry:/poetry|poem|verse/i,Drama:/drama|plays|tragedy|comedy/i,Children:/children|juvenile|fairy tales/i,History:/history|historical/i,Geography:/geography|countries|world history|civilization/i,Astronomy:/astronomy|stars|planets|universe/i,Science:/science|biology|physics|mathematics|natural history/i,Religion:/religion|bible|theology|christianity/i,Philosophy:/philosophy|ethics/i,Law:/\blaw\b|legislation|legal/i,Adventure:/adventure/i,Mystery:/mystery|detective/i,Biography:/biography|autobiography|memoir/i,Travel:/travel|description and travel/i,Nature:/nature|animals|plants/i,Culture:/customs|folklore|civilization|social life/i,Romance:/romance|love stories|courtship/i,'Comics & Cartoons':/comic books|cartoons|manga|graphic novels/i,'Comedy & Humor':/comedy|humor|humour|satire|parody|wit/i,'Brain & Mind':/brain|neuroscience|cognition|psychology|mind/i,Bible:/\bbible\b|biblical studies|bible stories/i,'General Knowledge':/general knowledge|trivia|encyclop|almanac|reference|facts and information/i};
const categoriesFor=(subjects:string[]=[]):string[]=>{const found=Object.entries(categoryRules).filter(([,pattern])=>subjects.some(subject=>pattern.test(subject))).map(([category])=>category);return found.length?found:['Other']};
const toBook=(b:Raw):Book|null=>{
  if(b.copyright!==false) return null;
  const formats:Format[]=[]; for(const [mime,url] of Object.entries(b.formats||{})){
    if(mime.includes('epub')&&!mime.includes('noimages')) formats.push({type:'EPUB',url});
    else if(mime.includes('html')&&mime.includes('zip')===false) formats.push({type:'HTML',url});
    else if(mime.includes('plain')&&mime.includes('text')) formats.push({type:'TXT',url});
  }
  if(!formats.length) return null;
  const landingUrl=`https://www.gutenberg.org/ebooks/${b.id}`;
  const lang=b.languages?.[0]||'und';
  const coverUrl=b.formats?.['image/jpeg']||b.formats?.['image/png'];
  formats.sort((a,b)=>a.type==='EPUB'?-1:b.type==='EPUB'?1:0);
  return {id:`gutenberg:${b.id}`,source:'Project Gutenberg',sourceUrl:landingUrl,title:b.title,authors:b.authors?.map(a=>a.name).join(', ')||'Unknown author',language:lang,license:'Public Domain (Gutenberg release)',rightsBasis:'Gutendex marks this record as public domain in the United States; verify the edition and your local copyright status at the source.',countryRestrictions:'May still be copyrighted or restricted outside the United States; check local rules.',attribution:'Project Gutenberg; book and edition details at the linked source.',formats,coverUrl,categories:categoriesFor(b.subjects)};
};

function hostOf(value:string){try{return new URL(value).host}catch{return 'invalid-host'}}
function errorInfo(error:unknown){
  const meta=error instanceof BookFetchError?error.meta:null;
  return {type:error instanceof BookFetchError?error.code:error instanceof Error?error.name:'unknown',host:meta?.host||null,finalHost:meta?.finalHost||null,status:meta?.status||null,message:error instanceof Error?error.message.slice(0,300):'unknown'};
}
function gutenbergPath(id:string){return id.split('').slice(0,-1).map(part=>`${part}/`).join('')+id}
async function fetchGutenberg<T>(raw:string|URL):Promise<T>{
  const url=typeof raw==='string'?raw:raw.toString();
  try{return (await fetchBookJson<T>(url,{label:'gutenberg:catalogue',accept:'application/json,text/plain;q=0.9,*/*;q=0.8',expected:/json|text\/plain/i,retries:2,timeoutMs:12000})).value}
  catch(error){console.warn('Gutenberg catalogue request failed',JSON.stringify({...errorInfo(error),host:hostOf(url)}));throw error}
}
function addHttpsUrl(urls:string[],value?:string){
  if(!value)return;
  try{const parsed=new URL(value);if(parsed.protocol==='https:')urls.push(parsed.toString())}catch{}
}
export function gutenbergDownloadUrls(id:string,extension:'epub'|'txt',original?:string){
  const urls:string[]=[];
  addHttpsUrl(urls,original);
  if(/^\d+$/.test(id)){
    addHttpsUrl(urls,`https://www.gutenberg.org/cache/epub/${id}/pg${id}.${extension}`);
    addHttpsUrl(urls,`https://aleph.gutenberg.org/${gutenbergPath(id)}/pg${id}.${extension}`);
  }
  return [...new Set(urls)];
}
export async function fetchGutenbergEpub(id:string,original:string|undefined,options:DownloadOptions={}){
  const urls=gutenbergDownloadUrls(id,'epub',original),label=options.label||`epub:${id}`;
  let last:unknown=new BookFetchError('empty','No Gutenberg EPUB mirror is available.',{host:'gutenberg.org',label});
  for(const [index,url] of urls.entries()){
    try{
      return await fetchBookBuffer(url,{...options,label:`${label}:mirror${index+1}`,expected:options.expected||/epub|zip|octet-stream/i,maxBytes:options.maxBytes??80*1024*1024});
    }catch(error){
      last=error;
      console.warn('Gutenberg EPUB mirror failed',JSON.stringify({bookId:id,mirror:index+1,...errorInfo(error),host:hostOf(url)}));
    }
  }
  throw last;
}
async function probe(label:string,url:string){
  try{
    const response=await fetchBookText(url,{label,accept:'text/plain,application/json,*/*;q=0.8',expected:/json|text\/|octet-stream/i,maxBytes:2*1024*1024,retries:1,timeoutMs:6000});
    return {ok:true,status:response.status,host:response.finalHost};
  }catch(error){
    console.warn('Gutenberg probe failed',JSON.stringify({label,...errorInfo(error),host:hostOf(url)}));
    return {ok:false,status:errorInfo(error).status};
  }
}
export const gutenberg:Adapter&{discover(language?:string,page?:number,topic?:string):Promise<{books:Book[];next?:string|null}>}={id:'gutenberg',async search(q,language,page=1){const u=new URL(BASE);u.searchParams.set('search',q);if(language&&language!=='all')u.searchParams.set('languages',language);u.searchParams.set('page',String(page));const data=await fetchGutenberg<{results:Raw[];next:string|null}>(u);return {books:data.results.map(toBook).filter((b):b is Book=>!!b),next:data.next};},async discover(language,page=1,topic=''){const u=new URL(BASE);u.searchParams.set('sort','popular');if(topic){const topicAliases:Record<string,string>={'education':'education','comics-cartoon':'comics','comedy-humor':'humor','general-knowledge':'knowledge','mystery':'detective fiction','romance':'love stories','children':'juvenile fiction','story-books':'fiction','brain-mind':'brain','bible':'bible'};u.searchParams.set('topic',topicAliases[topic]||topic);}if(language&&language!=='all')u.searchParams.set('languages',language);u.searchParams.set('page',String(page));const data=await fetchGutenberg<{results:Raw[];next:string|null}>(u);const books=data.results.map(toBook).filter((b):b is Book=>!!b);return {books,next:data.next};},async getDetails(id){const n=id.replace('gutenberg:','');if(!/^\d+$/.test(n))return null;try{return toBook(await fetchGutenberg<Raw>(`${BASE}${encodeURIComponent(n)}`))}catch{return null}},getReadableFormats:b=>b.formats,async health(){const probes=await Promise.all([probe('gutenberg:gutendex','https://gutendex.com/books/?page=1'),probe('gutenberg:cache',`https://www.gutenberg.org/cache/epub/${HEALTH_BOOK_ID}/pg${HEALTH_BOOK_ID}.txt`),probe('gutenberg:aleph',`https://aleph.gutenberg.org/${gutenbergPath(HEALTH_BOOK_ID)}/pg${HEALTH_BOOK_ID}.txt`)]);const healthy=probes.some(result=>result.ok);if(!healthy)console.warn('Gutenberg health probes all failed',JSON.stringify({probes}));return healthy}};
