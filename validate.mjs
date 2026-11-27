// 只验证唯一正式版 V2.0.3 的网页静态资源及服务器脚本。
// 本检查不访问 Cloudflare、Notion，也不修改任何外部数据。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
const site=path.resolve('site');
const required={
 'index.html':60000, '_worker.js':18000, '_routes.json':20,
 'manifest.webmanifest':150, 'icon-192.png':10000, 'icon-512.png':50000,
 'robots.txt':10, '.well-known/assetlinks.json':120
};
for(const [name,minBytes] of Object.entries(required)){
 const p=path.join(site,name);
 if(!fs.existsSync(p)||fs.statSync(p).size<minBytes)throw Error(`必需文件缺失或异常: ${name}`);
}
const html=fs.readFileSync(path.join(site,'index.html'),'utf8');
const worker=fs.readFileSync(path.join(site,'_worker.js'),'utf8');
for(const name of ['WUXIE_RELEASE_V203_BASE_V202','id="record-editor"','id="income-total"','id="budget-total"','id="sync-notion-now"',"/api/state","/api/goals","/api/pains"]){
 if(!(html+worker).includes(name))throw Error(`关键功能不存在: ${name}`);
}
for(const name of ['Cf-Access-Jwt-Assertion','CF_ACCESS_AUD','NOTION_TOKEN','NOTION_GOALS_SOURCE_ID','NOTION_PAINS_SOURCE_ID']){
 if(!worker.includes(name))throw Error(`访问保护或云端绑定缺失: ${name}`);
}
if(/(?:ntn_|secret_)[a-zA-Z0-9]{20,}/.test(html+worker))throw Error('疑似将 Notion 密钥写入了 GitHub 源码');
for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi))new vm.Script(match[1]);
for(const name of ['_worker.js','needs.js','needs-ui.js','goal-atlas.js'])execFileSync(process.execPath,['--check',path.join(site,name)]);
execFileSync(process.execPath,['test-needs.cjs'],{stdio:'inherit'});
execFileSync(process.execPath,['test-goal-atlas.cjs'],{stdio:'inherit'});
const routes=JSON.parse(fs.readFileSync(path.join(site,'_routes.json'),'utf8'));
if(!routes.include?.includes('/*'))throw Error('Pages Worker 访问保护路由不完整');
console.log('OK: V2.0.3 基于 V2.0.2 的 HTML、API、保护机制与全部静态资源校验通过');
