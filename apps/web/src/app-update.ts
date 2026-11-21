import {App} from '@capacitor/app';
import {Capacitor,registerPlugin} from '@capacitor/core';
import {LocalNotifications} from '@capacitor/local-notifications';

export type PublishedAppUpdate={versionCode:number;versionName:string;sha256:string;publishedAt?:string;mandatory?:boolean};
export type InstalledAppInfo={versionName:string;versionCode:number;lastUpdatedAt:string|null;source:'native'|'build';justUpdated:boolean};
export type AppUpdateStatus={available:boolean;installedVersionCode:number;installed:InstalledAppInfo;release:PublishedAppUpdate};

type NativeUpdaterPlugin={
  getAppVersion():Promise<{versionCode:number;versionName:string}>;
  getInstallInfo():Promise<{versionCode:number;versionName:string;lastUpdateTime?:number|null}>;
  installUpdate(options:{url:string;sha256:string;apiHost:string}):Promise<{permissionRequired:boolean}>;
};
const NativeUpdater=registerPlugin<NativeUpdaterPlugin>('AppUpdater');
const LAST_SEEN_KEY='foryou:lastSeenVersion';
const LAST_UPDATED_KEY='foryou:lastUpdatedAt';
const ANNOUNCED_KEY='foryou:update-announced';
const NOTIFIED_KEY_PREFIX='foryou:update-notified:';

function readStore(key:string){try{return typeof localStorage==='undefined'?null:localStorage.getItem(key)}catch{return null}}
function writeStore(key:string,value:string){try{if(typeof localStorage!=='undefined')localStorage.setItem(key,value)}catch{}}
function versionKey(info:{versionName:string;versionCode:number}){return `${info.versionName} (${info.versionCode})`}

export function formatAppDateTime(value:string|number|Date|null|undefined){
  if(value===null||value===undefined||value==='')return 'Not available';
  const date=value instanceof Date?value:new Date(value);
  if(Number.isNaN(date.getTime()))return 'Not available';
  const day=new Intl.DateTimeFormat(undefined,{day:'numeric',month:'short',year:'numeric'}).format(date);
  const time=new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit'}).format(date);
  return `${day}, ${time}`;
}

export function consumeUpdateAnnouncement(info:InstalledAppInfo){
  if(!info.justUpdated)return null;
  const key=versionKey(info);
  if(readStore(ANNOUNCED_KEY)===key)return null;
  writeStore(ANNOUNCED_KEY,key);
  return info.versionName;
}

export async function notifyAppUpdate(versionName:string){
  if(!Capacitor.isNativePlatform())return;
  const key=`${NOTIFIED_KEY_PREFIX}${versionName}`;
  if(readStore(key))return;
  try{
    const permission=await LocalNotifications.requestPermissions();
    if(permission.display!=='granted')return;
    await LocalNotifications.schedule({notifications:[{id:Date.now()%2000000000,title:'Update available',body:`New update available (v${versionName})`,schedule:{at:new Date(Date.now()+1000)}}]});
    writeStore(key,versionName);
  }catch{}
}

export async function getInstalledAppInfo():Promise<InstalledAppInfo>{
  let info:InstalledAppInfo={versionName:__APP_VERSION_NAME__,versionCode:__APP_VERSION_CODE__,lastUpdatedAt:null,source:'build',justUpdated:false};

  if(Capacitor.isNativePlatform()){
    const [appResult,nativeResult]=await Promise.allSettled([App.getInfo(),NativeUpdater.getInstallInfo()]);
    const app=appResult.status==='fulfilled'?appResult.value:null;
    const native=nativeResult.status==='fulfilled'?nativeResult.value:null;
    if(app||native){
      const buildCode=Number(app?.build),nativeCode=Number(native?.versionCode);
      const versionCode=native&&Number.isFinite(nativeCode)&&nativeCode>0?nativeCode:Number.isFinite(buildCode)&&buildCode>0?buildCode:info.versionCode;
      info={
        versionName:app?.version||native?.versionName||info.versionName,
        versionCode,
        lastUpdatedAt:native?.lastUpdateTime&&native.lastUpdateTime>0?new Date(native.lastUpdateTime).toISOString():null,
        source:'native',
        justUpdated:false
      };
    }
  }

  const key=versionKey(info),storedVersion=readStore(LAST_SEEN_KEY),storedUpdated=readStore(LAST_UPDATED_KEY);
  if(storedVersion!==key){
    const lastUpdatedAt=info.lastUpdatedAt||new Date().toISOString();
    writeStore(LAST_SEEN_KEY,key);
    writeStore(LAST_UPDATED_KEY,lastUpdatedAt);
    info={...info,lastUpdatedAt,justUpdated:!!storedVersion};
  }else if(!info.lastUpdatedAt&&storedUpdated){
    info={...info,lastUpdatedAt:storedUpdated};
  }else if(info.lastUpdatedAt){
    writeStore(LAST_UPDATED_KEY,info.lastUpdatedAt);
  }
  return info;
}

async function fetchPublishedUpdate(apiBase:string){
  const response=await fetch(`${apiBase}/app/update`,{cache:'no-store',credentials:'include'});
  if(!response.ok)throw new Error(response.status===404?'No app update has been published yet.':'Could not check for an app update.');
  const release=await response.json() as PublishedAppUpdate;
  if(!Number.isInteger(release.versionCode)||!release.sha256)throw new Error('The update information is incomplete.');
  return release;
}

export async function checkForAppUpdate(apiBase:string):Promise<AppUpdateStatus>{
  const [installed,release]=await Promise.all([getInstalledAppInfo(),fetchPublishedUpdate(apiBase)]);
  return {available:release.versionCode>installed.versionCode,installedVersionCode:installed.versionCode,installed,release};
}

export async function checkForNativeUpdate(apiBase:string):Promise<AppUpdateStatus>{
  if(!Capacitor.isNativePlatform())throw new Error('App updates are available in the Android app.');
  return checkForAppUpdate(apiBase);
}

export async function installNativeUpdate(apiBase:string,release:PublishedAppUpdate){
  if(!Capacitor.isNativePlatform())throw new Error('App updates are available in the Android app.');
  const url=`${apiBase}/app/update.apk`;
  return NativeUpdater.installUpdate({url,sha256:release.sha256,apiHost:new URL(apiBase).host});
}
