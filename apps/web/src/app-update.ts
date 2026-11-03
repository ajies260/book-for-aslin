import {Capacitor,registerPlugin} from '@capacitor/core';

export type PublishedAppUpdate={versionCode:number;versionName:string;sha256:string;publishedAt:string};
export type AppUpdateStatus={available:boolean;installedVersionCode:number;release:PublishedAppUpdate};

type NativeUpdaterPlugin={
  getAppVersion():Promise<{versionCode:number;versionName:string}>;
  installUpdate(options:{url:string;sha256:string;apiHost:string}):Promise<{permissionRequired:boolean}>;
};
const NativeUpdater=registerPlugin<NativeUpdaterPlugin>('AppUpdater');

export async function checkForNativeUpdate(apiBase:string):Promise<AppUpdateStatus>{
  if(!Capacitor.isNativePlatform())throw new Error('App updates are available in the Android app.');
  const [installed,response]=await Promise.all([
    NativeUpdater.getAppVersion(),
    fetch(`${apiBase}/app/update`,{cache:'no-store',credentials:'include'})
  ]);
  if(!response.ok)throw new Error(response.status===404?'No app update has been published yet.':'Could not check for an app update.');
  const release=await response.json() as PublishedAppUpdate;
  if(!Number.isInteger(release.versionCode)||!release.sha256)throw new Error('The update information is incomplete.');
  return {available:release.versionCode>installed.versionCode,installedVersionCode:installed.versionCode,release};
}

export async function installNativeUpdate(apiBase:string,release:PublishedAppUpdate){
  const url=`${apiBase}/app/update.apk`;
  return NativeUpdater.installUpdate({url,sha256:release.sha256,apiHost:new URL(apiBase).host});
}
