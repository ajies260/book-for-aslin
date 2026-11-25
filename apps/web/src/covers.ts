export type CoverSize='M'|'L';
export type CoverBook={title:string;authors:string;coverUrl?:string;coverId?:number|string;olid?:string;isbn?:string;id?:string};
export type CoverSource={src:string;srcSet:string};

const OPEN_LIBRARY_HOST='covers.openlibrary.org';
const PALETTES=[
 {background:'#efe4f6',foreground:'#4b3560',accent:'#b990d3'},
 {background:'#e3f0e7',foreground:'#2f4f3d',accent:'#8fba9a'},
 {background:'#f6eadc',foreground:'#60472d',accent:'#d5ad7c'},
 {background:'#e5edf7',foreground:'#324962',accent:'#8fb0d2'},
 {background:'#f7e5e8',foreground:'#633b45',accent:'#d29aa7'},
 {background:'#eee8d9',foreground:'#554f35',accent:'#b9ad77'}
];

export function coverPalette(seed:string){
 let hash=0;
 for(let index=0;index<seed.length;index++)hash=(hash*31+seed.charCodeAt(index))|0;
 return PALETTES[Math.abs(hash)%PALETTES.length];
}
function openLibraryUrl(kind:'id'|'olid'|'isbn',value:string,size:CoverSize){
 return `https://${OPEN_LIBRARY_HOST}/b/${kind}/${encodeURIComponent(value)}-${size}.jpg?default=false`;
}
function openLibrarySource(kind:'id'|'olid'|'isbn',value:string,size:CoverSize):CoverSource{
 const medium=openLibraryUrl(kind,value,'M'),large=openLibraryUrl(kind,value,'L');
 return size==='L'?{src:large,srcSet:`${large} 1x`}:{src:medium,srcSet:`${medium} 1x, ${large} 2x`};
}
function parseOpenLibraryUrl(value:string){
 try{
  const url=new URL(value);
  if(url.hostname!==OPEN_LIBRARY_HOST)return null;
  const parts=url.pathname.split('/').filter(Boolean);
  if(parts[0]!=='b'||(parts[1]!=='id'&&parts[1]!=='olid'&&parts[1]!=='isbn'))return null;
  const match=/^(.+)-(S|M|L)\.jpg$/i.exec(parts[2]||'');
  if(!match)return null;
  return {kind:parts[1] as 'id'|'olid'|'isbn',value:decodeURIComponent(match[1])};
 }catch{return null}
}
function workOlid(book:CoverBook){
 const workId=book.id?.startsWith('openlibrary:')?book.id.split(':')[1]:'';
 return workId?/^OL\d+W$/i.test(workId)?workId:`OL${workId}W`:'';
}
export function coverSource(book:CoverBook,size:CoverSize='M'):CoverSource|null{
 if(book.coverUrl){
  const parsed=parseOpenLibraryUrl(book.coverUrl);
  if(parsed)return openLibrarySource(parsed.kind,parsed.value,size);
  return {src:book.coverUrl,srcSet:`${book.coverUrl} 1x`};
 }
 if(book.coverId!==undefined&&book.coverId!==null&&book.coverId!=='')return openLibrarySource('id',String(book.coverId),size);
 if(book.olid)return openLibrarySource('olid',book.olid,size);
 if(book.isbn)return openLibrarySource('isbn',book.isbn,size);
 const olid=workOlid(book);
 if(olid)return openLibrarySource('olid',olid,size);
 return null;
}
