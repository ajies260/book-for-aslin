import {offlineDelete,offlineGet,offlineSetStrict} from './offline';

export type OfflineBookRecord={
 book:any;
 savedAt:string;
 kind:'metadata'|'text'|'epub'|'pdf';
 text?:string;
 bytes?:ArrayBuffer;
};

const INDEX_KEY='offline-book-index';
const bookKey=(id:string)=>`offline-book:${id}`;

export async function getOfflineBook(id:string){return offlineGet<OfflineBookRecord>(bookKey(id))}

export async function listOfflineBooks(){
 const ids=await offlineGet<string[]>(INDEX_KEY)||[];
 const records=await Promise.all(ids.map(id=>getOfflineBook(id)));
 return records.filter((record):record is OfflineBookRecord=>!!record?.book?.id);
}

export async function saveOfflineBook(record:OfflineBookRecord){
 await offlineSetStrict(bookKey(record.book.id),record);
 const ids=await offlineGet<string[]>(INDEX_KEY)||[];
 if(!ids.includes(record.book.id))await offlineSetStrict(INDEX_KEY,[...ids,record.book.id]);
}

export async function deleteOfflineBook(id:string){
 await offlineDelete(bookKey(id));
 const ids=await offlineGet<string[]>(INDEX_KEY)||[];
 await offlineSetStrict(INDEX_KEY,ids.filter(item=>item!==id));
}
