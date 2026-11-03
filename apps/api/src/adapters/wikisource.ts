import {Adapter,Book,Format} from './types';
const WIKIS:Record<string,string>={en:'en.wikisource.org',ta:'ta.wikisource.org',hi:'hi.wikisource.org',bn:'bn.wikisource.org',ml:'ml.wikisource.org'};
const api=(host:string)=>`https://${host}/w/api.php`;
type SearchPage={query?:{search?:{title:string; pageid:number}[]}};
type ParsedPage={pageid:number;title:string;displaytitle?:string;text:string};
export async function getWikisourceText(id:string){
 const match=id.match(/^wikisource:([a-z]{2}):(\d+)$/);
 if(!match)return null;
 const [,lang,pageid]=match,host=WIKIS[lang];
 if(!host)return null;
 const u=new URL(api(host));
 Object.entries({action:'parse',pageid,prop:'text',disableeditsection:'1',format:'json',formatversion:'2'}).forEach(([k,v])=>u.searchParams.set(k,v));
 const r=await fetch(u,{headers:{'User-Agent':`ForYouBooks/1.0 (contact: ${process.env.ADMIN_EMAIL||'configure ADMIN_EMAIL'})`},signal:AbortSignal.timeout(12000)});
 if(!r.ok)throw new Error(`Wikisource ${r.status}`);
 const d=await r.json() as {parse?:ParsedPage};
 const page=d.parse;
 if(!page?.text?.trim())return null;
 return {title:page.title,html:page.text,sourceUrl:`https://${host}/wiki/${encodeURIComponent(page.title.replace(/ /g,'_'))}`};
}
async function doSearch(q:string,lang='en',page=1){const host=WIKIS[lang]||WIKIS.en;const u=new URL(api(host));Object.entries({action:'query',list:'search',srsearch:q,srnamespace:'0',srlimit:'20',format:'json',origin:'*',sroffset:String((page-1)*20)}).forEach(([k,v])=>u.searchParams.set(k,v));const r=await fetch(u,{headers:{'Api-User-Agent':`ForYouBooks/1.0 (contact: ${process.env.ADMIN_EMAIL||'configure ADMIN_EMAIL'})`},signal:AbortSignal.timeout(10000)});if(!r.ok)throw new Error(`Wikisource ${r.status}`);const d=await r.json() as SearchPage;return (d.query?.search||[]).map(p=>{const title=p.title;const url=`https://${host}/wiki/${encodeURIComponent(title.replace(/ /g,'_'))}`;const book:Book={id:`wikisource:${lang}:${p.pageid}`,source:`Wikisource (${lang})`,sourceUrl:url,title,authors:'Wikisource contributors',language:lang,license:'Public domain or CC BY-SA (verify on source page)',rightsBasis:'Wikisource page-level licensing varies; confirm the license and that the linked page contains the complete work.',countryRestrictions:'Copyright status may vary by country; verify locally.',attribution:'Wikisource contributors; see the source page for authors and license.',formats:[{type:'HTML',url}]};return book})}
export const wikisource:Adapter={id:'wikisource',async search(q,language='en',page=1){const resolved=language&&language!=='all'?language:/[\u0B80-\u0BFF]/u.test(q)?'ta':/[\u0900-\u097F]/u.test(q)?'hi':'en';const books=await doSearch(q,resolved,page);return {books,next:books.length===20?String(page+1):null}},async getDetails(id){const [,lang,pid]=id.split(':');const host=WIKIS[lang]||WIKIS.en;const r=await fetch(`${api(host)}?action=query&pageids=${encodeURIComponent(pid)}&prop=info&inprop=url&format=json`,{headers:{'Api-User-Agent':`ForYouBooks/1.0 (contact: ${process.env.ADMIN_EMAIL||'configure ADMIN_EMAIL'})`},signal:AbortSignal.timeout(8000)});if(!r.ok)return null;const d=await r.json() as {query?:{pages?:Record<string,{title:string;fullurl:string}>}};const p=Object.values(d.query?.pages||{})[0];if(!p)return null;return {id,source:`Wikisource (${lang})`,sourceUrl:p.fullurl,title:p.title,authors:'Wikisource contributors',language:lang,license:'Public domain or CC BY-SA (verify on source page)',rightsBasis:'Wikisource page-level licensing varies; confirm the license and that the linked page contains the complete work.',countryRestrictions:'Copyright status may vary by country; verify locally.',attribution:'Wikisource contributors; see the source page for authors and license.',formats:[{type:'HTML',url:p.fullurl}]}},getReadableFormats:b=>b.formats,async health(){try{return (await fetch(`${api('en.wikisource.org')}?action=query&format=json&meta=siteinfo`,{headers:{'Api-User-Agent':`ForYouBooks/1.0 (contact: ${process.env.ADMIN_EMAIL||'configure ADMIN_EMAIL'})`},signal:AbortSignal.timeout(5000)})).ok}catch{return false}}};
