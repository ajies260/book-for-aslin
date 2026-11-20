import 'dotenv/config';
import dotenv from 'dotenv';
import {PrismaClient} from '@prisma/client';
import argon2 from 'argon2';
import {resolve} from 'node:path';

dotenv.config({path:resolve(process.cwd(),'../../.env')});

const prisma=new PrismaClient();
const emailPattern=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Account={email:string;password:string;role:'ADMIN'|'MEMBER';preferredSlot:number};

function readAccount(emailValue:string|undefined,passwordValue:string|undefined,role:'ADMIN'|'MEMBER',preferredSlot:number):Account|null{
 const email=(emailValue||'').trim().toLowerCase();
 const password=passwordValue||'';
 if(!email||!password.trim())return null;
 if(!emailPattern.test(email))throw new Error('A configured email address is not valid.');
 return {email,password,role,preferredSlot};
}

async function main(){
 const admin=readAccount(process.env.ADMIN_EMAIL,process.env.ADMIN_PASSWORD,'ADMIN',1);
 if(!admin)throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD must be set before seeding.');
 const members=[1,2,3,4,5,6]
  .map(i=>readAccount(process.env[`MEMBER${i}_EMAIL`],process.env[`MEMBER${i}_PASSWORD`],'MEMBER',i+1))
  .filter((account):account is Account=>!!account);
 const accounts=[admin,...members];
 if(new Set(accounts.map(account=>account.email)).size!==accounts.length)throw new Error('Configured account emails must be unique.');
 const currentUsers=await prisma.user.findMany({select:{email:true,accountSlot:true}});
 const byEmail=new Map(currentUsers.map(user=>[user.email.toLowerCase(),user]));
 const newAccounts=accounts.filter(account=>!byEmail.has(account.email));
 if(currentUsers.length+newAccounts.length>7)throw new Error('Cannot seed accounts: the seven-account limit would be exceeded.');
 const usedSlots=new Set(currentUsers.map(user=>user.accountSlot));
 const assignedSlots=new Map<string,number>();
 for(const account of newAccounts){
  const slot=[account.preferredSlot,...Array.from({length:7},(_,index)=>index+1)].find(candidate=>!usedSlots.has(candidate));
  if(!slot)throw new Error('No approved account slots remain.');
  usedSlots.add(slot);
  assignedSlots.set(account.email,slot);
 }
 for(const account of accounts){
  const existing=byEmail.get(account.email);
  const passwordHash=await argon2.hash(account.password);
  const slot=existing?.accountSlot??assignedSlots.get(account.email)!;
  await prisma.user.upsert({
   where:{email:account.email},
   create:{email:account.email,passwordHash,role:account.role,accountSlot:slot,active:true},
   update:{email:account.email,passwordHash,role:account.role,active:true}
  });
 }
 await prisma.source.upsert({where:{id:'gutenberg'},create:{id:'gutenberg',name:'Project Gutenberg',baseUrl:'https://www.gutenberg.org/',licensePolicy:'Only Gutendex copyright=false records with readable formats; verify territorial rights at source.'},update:{}});
 await prisma.source.upsert({where:{id:'wikisource'},create:{id:'wikisource',name:'Wikisource',baseUrl:'https://www.wikisource.org/',licensePolicy:'Page-specific PD or CC BY-SA; individual page license/attribution must be checked.'},update:{}});
 console.log(`Seeded/updated ${accounts.length} approved account(s).`);
}
main().catch(error=>{
 const code=(error as {code?:unknown})?.code;
 console.error(`Seeding failed${code?` (${String(code)})`:''}. Check environment variables and database connectivity.`);
 process.exitCode=1;
}).finally(()=>prisma.$disconnect());
