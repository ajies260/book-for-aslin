import {readFileSync} from 'node:fs';import {resolve} from 'node:path';import {fileURLToPath} from 'node:url';import {defineConfig} from 'vite';import react from '@vitejs/plugin-react';
const root=fileURLToPath(new URL('.',import.meta.url));
const gradle=readFileSync(resolve(root,'android/app/build.gradle'),'utf8');
const appVersionCode=Number(gradle.match(/versionCode\s+(\d+)/)?.[1]||0);
const appVersionName=gradle.match(/versionName\s+"([^"]+)"/)?.[1]||'1.0.0';
export default defineConfig({plugins:[react()],server:{port:5173,strictPort:true},envDir:'../..',define:{__APP_VERSION_NAME__:JSON.stringify(appVersionName),__APP_VERSION_CODE__:JSON.stringify(appVersionCode)}})
