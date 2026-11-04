import dotenv from 'dotenv';
import {PrismaClient} from '@prisma/client';
import argon2 from 'argon2';
import {resolve} from 'node:path';
dotenv.config({path:resolve(process.cwd(),'../../.env')});
const prisma=new PrismaClient();
async function main(){
 const accounts=[{email:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD,role:'ADMIN'},...[1,2,3,4,5,6].map(i=>({email:process.env[`MEMBER${i}_EMAIL`],password:process.env[`MEMBER${i}_PASSWORD`],role:'MEMBER'}))].filter(x=>x.email&&x.password) as {email:string;password:string;role:string}[];
 if(!accounts.length)throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD in .env before seeding.');
 if(accounts.length>7)throw new Error('A maximum of seven accounts may be seeded.');
 const currentUsers=await prisma.user.findMany({select:{id:true,email:true,accountSlot:true}});
 const byEmail=new Map(currentUsers.map(u=>[u.email,u]));
 const newCount=accounts.filter(a=>!byEmail.has(a.email.toLowerCase())).length;
 if(currentUsers.length+newCount>7)throw new Error(`Cannot seed ${newCount} new account(s): the seven-account limit would be exceeded.`);
 const usedSlots=new Set(currentUsers.map(u=>u.accountSlot));
 for(const a of accounts){
  const email=a.email.toLowerCase(), existing=byEmail.get(email), passwordHash=await argon2.hash(a.password);
  if(existing)await prisma.user.update({where:{email},data:{passwordHash,role:a.role,active:true}});
  else {const slot=[1,2,3,4,5,6,7].find(n=>!usedSlots.has(n));if(!slot)throw new Error('No approved account slots remain.');usedSlots.add(slot);await prisma.user.create({data:{email,passwordHash,role:a.role,accountSlot:slot}})}
 }
 await prisma.source.upsert({where:{id:'gutenberg'},create:{id:'gutenberg',name:'Project Gutenberg',baseUrl:'https://www.gutenberg.org/',licensePolicy:'Only Gutendex copyright=false records with readable formats; verify territorial rights at source.'},update:{}});
 await prisma.source.upsert({where:{id:'wikisource'},create:{id:'wikisource',name:'Wikisource',baseUrl:'https://www.wikisource.org/',licensePolicy:'Page-specific PD or CC BY-SA; individual page license/attribution must be checked.'},update:{}});
 console.log(`Seeded/updated ${accounts.length} approved account(s).`);
}
main().finally(()=>prisma.$disconnect());
