import {Capacitor} from '@capacitor/core';
import {Preferences} from '@capacitor/preferences';

const TOKEN_KEY='foryou:session';

function legacyGet(){try{return localStorage.getItem(TOKEN_KEY)||''}catch{return ''}}
function legacySet(token:string){try{if(token)localStorage.setItem(TOKEN_KEY,token);else localStorage.removeItem(TOKEN_KEY)}catch{}}

export async function getSessionToken(){
  try{
    if(Capacitor.isNativePlatform()){
      const stored=await Preferences.get({key:TOKEN_KEY});
      if(stored.value)return stored.value;
      const legacy=legacyGet();
      if(legacy){
        await Preferences.set({key:TOKEN_KEY,value:legacy});
        legacySet('');
        return legacy;
      }
      return '';
    }
  }catch{}
  return legacyGet();
}

export async function setSessionToken(token:string){
  try{
    if(Capacitor.isNativePlatform()){
      if(token)await Preferences.set({key:TOKEN_KEY,value:token});
      else await Preferences.remove({key:TOKEN_KEY});
    }
  }catch{}
  legacySet(token);
}
