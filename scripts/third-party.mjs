// Dependency notices from the installed, lockfile-pinned packages. No network access.
import fs from 'node:fs';
import path from 'node:path';
const root=process.cwd();
const lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'),'utf8'));
const sections=['THIRD-PARTY NOTICES\n\nHotel Manager is MIT-licensed. Dependencies retain their own licenses.\nThis inventory includes installed npm packages, including build tools. Native Android Gradle dependencies require a separate release review.\n'];
let count=0;
for(const [location,metadata] of Object.entries(lock.packages??{}).sort(([a],[b])=>a.localeCompare(b))) {
  if(!location.includes('node_modules/')||metadata.link) continue;
  const directory=path.join(root,location);
  if(!fs.existsSync(path.join(directory,'package.json'))) continue;
  const pkg=JSON.parse(fs.readFileSync(path.join(directory,'package.json'),'utf8'));
  if(pkg.name?.startsWith('@hotel-manager/')) continue;
  const names=fs.readdirSync(directory).filter(name=>/^(license|licence|copying|notice)(\.|-|$)/i.test(name)&&fs.statSync(path.join(directory,name)).isFile());
  sections.push(`\n${'='.repeat(72)}\n${pkg.name}@${pkg.version}\nLicense: ${typeof pkg.license==='string'?pkg.license:JSON.stringify(pkg.license??pkg.licenses??'REVIEW REQUIRED')}\n`);
  for(const name of names) sections.push(`\n${name}\n${fs.readFileSync(path.join(directory,name),'utf8')}\n`);
  if(!names.length) sections.push('No standalone license text found at package root; review package license metadata before release.\n');
  count++;
}
const notice=sections.join('');
fs.writeFileSync(path.join(root,'THIRD_PARTY_NOTICES.txt'),notice);
if(fs.existsSync(path.join(root,'packages/ui/public'))) fs.writeFileSync(path.join(root,'packages/ui/public/THIRD_PARTY_NOTICES.txt'),notice);
console.log(`Dependency notice inventory written: ${count} installed npm packages.`);
