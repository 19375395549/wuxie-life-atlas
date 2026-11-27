/* 无邪人生目标导航系统 V2.0.3 — 基于线上 V2.0.2 的 Cloudflare Pages Worker
 * Notion remains the single cloud data source. This Worker NEVER contains credentials.
 * Required encrypted/secret bindings: NOTION_TOKEN, ALLOWED_EMAIL,
 * NOTION_GOALS_SOURCE_ID, NOTION_PAINS_SOURCE_ID, CF_ACCESS_AUD, CF_ACCESS_TEAM_DOMAIN.
 * Fail closed: if Access/JWT/settings are missing, the site and all APIs are blocked.
 */
const VERSION='2025-09-03';
const GOAL_FIELDS={name:'目标名称',id:'编号',branch:'类别',parent:'上级编号',budget:'预算人民币',type:'预算类型',actual:'实际金额',priority:'优先级',note:'说明'};
const PAIN_FIELDS={name:'痛点名称',id:'编号',tier:'层级',links:'关联目标编号',relation:'对应目标',note:'备注'};
const TIER_NAMES={'L0':'P0 生存保障','L1':'P1 经济与职业安全','L2':'P2 健康与生活','L3':'P3 资源与跨境能力','L4':'P4 情感与关系','L5':'P5 发展与商业'};
const CATEGORY_PREFIX='CAT:';
const GOAL_ROOT='V1.8';
const DEFAULT_GOALS=[
  ['G001','现金财富积累目标',GOAL_ROOT],['G002','生活物质与消费目标',GOAL_ROOT],
  ['G003','投资资产目标',GOAL_ROOT],['A','食品、服饰及温饱保障','G002'],
  ['B','房产、交通及数码设备','G002'],['C','健康与运动','G002'],
  ['D','AI、办公软件及数字服务','G002']
];
function defaultCategories(kind){
  const entries=kind==='goals'?DEFAULT_GOALS:Object.entries(TIER_NAMES).map(([id,name])=>[id,name,'']);
  return entries.map(([id,name,parent],order)=>({id,name,parent,order}));
}
function categoriesFromPages(kind,pages){
  const defaults=new Map(defaultCategories(kind).map(category=>[category.id,category]));
  const fields=kind==='goals'?GOAL_FIELDS:PAIN_FIELDS;
  for(const page of pages){
    const properties=page.properties||{};
    const code=readPlain(properties[fields.id]);
    if(!code.startsWith(CATEGORY_PREFIX))continue;
    const id=code.slice(CATEGORY_PREFIX.length);
    if(!defaults.has(id)&&!/^n-[0-9a-f-]{36}$/.test(id))continue;
    try {
      const {parent,order,deleted}=JSON.parse(readPlain(properties[fields.note]));
      if(typeof parent!=='string'||!Number.isSafeInteger(order))continue;
      defaults.set(id,{id,name:readPlain(properties[fields.name]),parent,order,deleted,pageId:page.id});
    } catch { /* Preserve the default when category metadata is malformed. */ }
  }
  const active=[...defaults.values()].filter(category=>!category.deleted);
  const byId=new Map(active.map(category=>[category.id,category]));
  const root=kind==='goals'?GOAL_ROOT:'';
  return active.map(category=>{
    const seen=new Set([category.id]);
    let parent=category.parent;
    while(parent!==root&&byId.has(parent)&&!seen.has(parent)){
      seen.add(parent);
      parent=byId.get(parent).parent;
    }
    return parent===root?category:{...category,parent:root};
  }).sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id));
}
function goalCategory(goal,categories){
  const index=Number(goal.id.split('-')[1]);
  const legacy=goal.id.startsWith('G002-')&&index>=1&&index<=26
    ? index<=7?'B':index<=9?'A':index===10?'C':'D'
    : goal.parent||goal.branch;
  const category=goal.parent.startsWith(CATEGORY_PREFIX)?goal.parent.slice(CATEGORY_PREFIX.length):legacy;
  return categories.some(node=>node.id===category)?category:GOAL_ROOT;
}
function requireCategory(kind,id,categories,allowRoot=false){
  const root=kind==='goals'?GOAL_ROOT:'';
  if((allowRoot&&id===root)||categories.some(category=>category.id===id))return id;
  throw Object.assign(new Error('分类已变化，请刷新后重新选择'),{status:400});
}
async function saveCategory(env,kind,category){
  const fields=kind==='goals'?GOAL_FIELDS:PAIN_FIELDS;
  const source=kind==='goals'?env.NOTION_GOALS_SOURCE_ID:env.NOTION_PAINS_SOURCE_ID;
  const {id,name,parent,order,deleted,pageId}=category;
  const properties={
    [fields.id]:textValue(CATEGORY_PREFIX+id),
    [fields.name]:titleValue(name),
    [fields.note]:textValue(JSON.stringify({parent,order,deleted}))
  };
  if(pageId)return notion(env,'/pages/'+pageId,{method:'PATCH',body:{properties}});
  return notion(env,'/pages',{method:'POST',body:{parent:{type:'data_source_id',data_source_id:source},properties}});
}
async function changeCategory(env,kind,id,method,data,current){
  const categories=current.hierarchy[kind];
  const root=kind==='goals'?GOAL_ROOT:'';
  if(method==='POST'){
    const parent=requireCategory(kind,data.parent??root,categories,true);
    await saveCategory(env,kind,{id:'n-'+crypto.randomUUID(),name:cleanName(data.name),parent,order:categories.length?Math.max(...categories.map(node=>node.order))+1:0});
    return;
  }
  const category=categories.find(node=>node.id===id);
  if(!category)throw Object.assign(new Error('找不到指定分类'),{status:404});
  if(method==='DELETE'){
    if(categories.some(node=>node.parent===id)||current[kind].some(record=>record.category===id)){
      throw Object.assign(new Error('请先移走下级分类和登记项，再删除此分类'),{status:409});
    }
    await saveCategory(env,kind,{...category,deleted:true});
    return;
  }
  const parent=requireCategory(kind,data.parent??category.parent,categories,true);
  const byId=new Map(categories.map(node=>[node.id,node]));
  for(let ancestor=parent;byId.has(ancestor);ancestor=byId.get(ancestor).parent){
    if(ancestor===id)throw Object.assign(new Error('分类不能移到自身或自己的下级'),{status:400});
  }
  const order=data.order??category.order;
  if(!Number.isSafeInteger(order)||Math.abs(order)>100000)throw Object.assign(new Error('排序必须为有效整数'),{status:400});
  await saveCategory(env,kind,{...category,name:cleanName(data.name??category.name),parent,order});
}
const MAX_AMOUNT=10000000000000;
const textValue=(value)=>({rich_text:[{type:'text',text:{content:String(value||'').slice(0,1800)}}]});
const titleValue=(value)=>({title:[{type:'text',text:{content:String(value).slice(0,100)}}]});
const selectValue=(value)=>({select:{name:value}});
function readPlain(prop){if(!prop)return '';const parts=prop.title||prop.rich_text||[];return parts.map(p=>p.plain_text??p.text?.content??'').join('');}
function readSelect(prop){return prop?.select?.name||'';}
function numberOrNull(value){return typeof value==='number'&&Number.isFinite(value)?value:null;}
function idFromPage(page){return page.id;}
function withHeaders(response){const h=new Headers(response.headers);h.set('X-Content-Type-Options','nosniff');h.set('Referrer-Policy','no-referrer');h.set('Cache-Control','no-store');h.set('X-Frame-Options','DENY');h.set('Content-Security-Policy',"frame-ancestors 'none'");return new Response(response.body,{status:response.status,statusText:response.statusText,headers:h});}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}
function fail(message,status=400){return json({ok:false,error:message},status);}
function decodeB64(str){const b64=str.replace(/-/g,'+').replace(/_/g,'/');const pad=b64.length%4?'='.repeat(4-b64.length%4):'';const bin=atob(b64+pad);return new Uint8Array(Array.from(bin,c=>c.charCodeAt(0)));}
function decodeJsonPart(part){return JSON.parse(new TextDecoder().decode(decodeB64(part)));}
let certCache={issuer:'',at:0,keys:[]};
async function checkAccess(request,env){
  const required=['NOTION_TOKEN','NOTION_GOALS_SOURCE_ID','NOTION_PAINS_SOURCE_ID','CF_ACCESS_AUD','CF_ACCESS_TEAM_DOMAIN','ALLOWED_EMAIL'];
  if(required.some(key=>!env[key]||typeof env[key]!=='string'))return {error:'网站尚未完成身份验证和数据密钥配置；为保护个人资料，已拒绝访问。',code:503};
  const token=request.headers.get('Cf-Access-Jwt-Assertion')||'';
  if(!token)return {error:'请先通过 Cloudflare Access 登录，才能查看个人目标资料。',code:401};
  const parts=token.split('.');if(parts.length!==3||parts.some(x=>x.length>20000))return {error:'登录凭证格式无效。',code:401};
  try{
    const hdr=decodeJsonPart(parts[0]), payload=decodeJsonPart(parts[1]);
    if(hdr.alg!=='RS256'||typeof hdr.kid!=='string')throw Error('algorithm');
    const issuer='https://'+env.CF_ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//,'').replace(/\/$/,'');
    const now=Math.floor(Date.now()/1000);
    if(payload.iss!==issuer||typeof payload.exp!=='number'||payload.exp<=now||(payload.nbf!==undefined&&(typeof payload.nbf!=='number'||payload.nbf>now))||(!Array.isArray(payload.aud)&&payload.aud!==env.CF_ACCESS_AUD) || (Array.isArray(payload.aud)&&!payload.aud.includes(env.CF_ACCESS_AUD)))throw Error('claims');
    if(String(payload.email||'').toLowerCase()!==env.ALLOWED_EMAIL.trim().toLowerCase())throw Error('email');
    if(certCache.issuer!==issuer||Date.now()-certCache.at>1800000){
      const response=await fetch(issuer+'/cdn-cgi/access/certs',{headers:{Accept:'application/json'}});
      if(!response.ok)throw Error('certs');
      const certs=await response.json();
      if(!Array.isArray(certs.keys))throw Error('missing keys');
      certCache={issuer,at:Date.now(),keys:certs.keys};
    }
    const jwk=certCache.keys.find(k=>k.kid===hdr.kid&&k.kty==='RSA');
    if(!jwk)throw Error('kid');
    const key=await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
    const ok=await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,decodeB64(parts[2]),new TextEncoder().encode(parts[0]+'.'+parts[1]));
    if(!ok)throw Error('sig');
    return {email:payload.email};
  }catch(error){return {error:'身份验证失败或已过期。请重新通过 Cloudflare Access 登录。',code:401};}
}
async function notion(env,path,options={}){
  const method=options.method||'GET';
  for(let attempt=0;attempt<3;attempt++){
    const response=await fetch('https://api.notion.com/v1'+path,{
      method,
      headers:{'Authorization':'Bearer '+env.NOTION_TOKEN,'Notion-Version':VERSION,'Content-Type':'application/json'},
      body:options.body===undefined?undefined:JSON.stringify(options.body)
    });
    if(response.status===429&&attempt<2){const wait=Math.min(1500,Math.max(300,Number(response.headers.get('Retry-After')||1)*1000));await new Promise(resolve=>setTimeout(resolve,wait));continue;}
    const body=await response.json().catch(()=>({}));
    if(!response.ok){
      let message=response.status===401?'Notion 授权密钥无效':response.status===403||response.status===404?'Notion 集成无权访问数据库，请检查连接的页面权限':'Notion 云端保存失败';
      if(response.status===429)message='Notion 限流，请稍后重试';
      throw Object.assign(new Error(message),{status:response.status});
    }
    return body;
  }
  throw new Error('Notion 请求次数受限');
}
async function queryAll(env,id){
  const results=[];let start_cursor;
  do {
    const res=await notion(env,'/data_sources/'+encodeURIComponent(id)+'/query',{method:'POST',body:{page_size:100,...(start_cursor?{start_cursor}:{})}});
    results.push(...(res.results||[]));start_cursor=res.has_more?res.next_cursor:null;
    if(results.length>1500)throw Object.assign(new Error('数据规模超过当前版本上限'),{status:413});
  }while(start_cursor);
  return results;
}
const GOAL_CODE = /^G00[123]-\d{2,}$/;
function asGoal(page){const p=page.properties||{};return {id:readPlain(p[GOAL_FIELDS.id]).trim() || page.id,pageId:page.id,name:readPlain(p[GOAL_FIELDS.name]),parent:readPlain(p[GOAL_FIELDS.parent]),branch:readSelect(p[GOAL_FIELDS.branch]),budget:numberOrNull(p[GOAL_FIELDS.budget]?.number),type:readSelect(p[GOAL_FIELDS.type]),actual:numberOrNull(p[GOAL_FIELDS.actual]?.number),priority:readSelect(p[GOAL_FIELDS.priority])||'待确认',note:readPlain(p[GOAL_FIELDS.note])};}
function asPain(page,idByPage){const p=page.properties||{};const relation=p[PAIN_FIELDS.relation];const related=(relation?.relation||[]).map(x=>idByPage[x.id]).filter(Boolean);const listed=readPlain(p[PAIN_FIELDS.links]).split(/[，,\s]+/).filter(x=>/^G00[123]-\d{2,}$/.test(x));const tierName=readSelect(p[PAIN_FIELDS.tier]);const tier=Object.keys(TIER_NAMES).find(x=>TIER_NAMES[x]===tierName)||(tierName.startsWith(CATEGORY_PREFIX)?tierName:'L3');return {id:readPlain(p[PAIN_FIELDS.id]),pageId:page.id,name:readPlain(p[PAIN_FIELDS.name]),tier,note:readPlain(p[PAIN_FIELDS.note]),links:[...new Set(Array.isArray(relation?.relation)?related:listed)]};}
async function state(env){
  const [goalPages,painPages]=await Promise.all([queryAll(env,env.NOTION_GOALS_SOURCE_ID),queryAll(env,env.NOTION_PAINS_SOURCE_ID)]);
  const rootPage=goalPages.find(page=>readPlain(page.properties?.[GOAL_FIELDS.id])===CATEGORY_PREFIX+GOAL_ROOT);
  const goalRoot={id:GOAL_ROOT,name:readPlain(rootPage?.properties?.[GOAL_FIELDS.name]).trim()||'无邪人生目标树',pageId:rootPage?.id};
  const hierarchy={goals:categoriesFromPages('goals',goalPages),pains:categoriesFromPages('pains',painPages)};
  const goals=goalPages.map(asGoal).filter(g=>GOAL_CODE.test(g.id)||(g.id===g.pageId&&g.name.trim()))
    .map(goal=>({...goal,category:goalCategory(goal,hierarchy.goals)}));
  const byId=Object.fromEntries(goals.map(g=>[g.pageId,g.id]));
  const pains=painPages.map(p=>asPain(p,byId)).filter(p=>/^P\d{3,}$/.test(p.id)).map(pain=>{
    const category=pain.tier.startsWith(CATEGORY_PREFIX)?pain.tier.slice(CATEGORY_PREFIX.length):pain.tier;
    return {...pain,category:hierarchy.pains.some(node=>node.id===category)?category:''};
  });
  return {ok:true,version:'V2.0.3',goals,pains,hierarchy,goalRoot,summary:{goalCount:goals.length,painCount:pains.length,consumption:goals.filter(x=>x.branch==='G002').reduce((a,x)=>a+(x.budget||0),0),investment:goals.filter(x=>x.branch==='G003').reduce((a,x)=>a+(x.budget||0),0)}};
}
function nextGoalCode(branch,arr){const n=arr.filter(x=>x.branch===branch&&GOAL_CODE.test(x.id)).reduce((max,x)=>Math.max(max,Number(x.id.split('-').at(-1))||0),0)+1;return branch+'-'+String(n).padStart(2,'0');}
function nextPainCode(arr){const n=arr.reduce((max,x)=>Math.max(max,Number(x.id.slice(1))||0),0)+1;return 'P'+String(n).padStart(3,'0');}
async function bodyJson(request,max=8000){
  if(!request.headers.get('content-type')?.toLowerCase().includes('application/json'))throw Object.assign(new Error('仅支持 JSON 登记请求'),{status:415});
  const raw=await request.text();if(raw.length>max)throw Object.assign(new Error('提交内容过长'),{status:413});
  try{const data=JSON.parse(raw);if(!data||typeof data!=='object'||Array.isArray(data))throw Error();return data;}
  catch{throw Object.assign(new Error('提交内容不是有效 JSON'),{status:400});}
}
function validateAmount(n){if(n===null||n===undefined||n==='')return null;if(typeof n!=='number'||!Number.isFinite(n)||n<0||n>MAX_AMOUNT)throw Object.assign(new Error('金额必须是合理的非负数字或留空'),{status:400});return n;}
function cleanName(value){const n=typeof value==='string'?value.trim():'';if(!n||n.length>100)throw Object.assign(new Error('名称不能为空，且不得超过100个字'),{status:400});return n;}
function cleanNote(value){return String(value||'').trim().slice(0,1000);}
function buildGoalProps({id,name,branch,budget,note,actual,priority}){
  const type=branch==='G002'?'60年消费':branch==='G003'?'投资本金':'现金目标';
  const p={"目标名称":titleValue(name),"编号":textValue(id),"上级编号":textValue(branch),"类别":selectValue(branch),"预算类型":selectValue(type),"优先级":selectValue(priority==='P0'?'P0':'待确认'),"说明":textValue(note)};
  if(budget!==undefined&&budget!==null)p['预算人民币']={number:budget};
  if(actual!==undefined&&actual!==null)p['实际金额']={number:actual};
  return p;
}
async function createGoal(env,data,existing,categories){
  const branch=data.branch;
  if(!['G001','G002','G003'].includes(branch))throw Object.assign(new Error('请选择有效的目标分支'),{status:400});
  const name=cleanName(data.name),budget=validateAmount(data.budget),note=cleanNote(data.note);
  if(existing.some(g=>g.branch===branch&&g.name.trim()===name))throw Object.assign(new Error('同一分支已存在此目标，请勿重复登记'),{status:409});
  const id=nextGoalCode(branch,existing),priority=data.priority==='P0'?'P0':'待确认';
  const props=buildGoalProps({id,name,branch,budget,note,priority});
  if(data.category!==undefined)props[GOAL_FIELDS.parent]=textValue(CATEGORY_PREFIX+requireCategory('goals',data.category,categories,true));
  const page=await notion(env,'/pages',{method:'POST',body:{parent:{type:'data_source_id',data_source_id:env.NOTION_GOALS_SOURCE_ID},properties:props}});
  return asGoal(page);
}
async function patchGoal(env,id,data,existing,categories){
  const goal=existing.find(g=>g.id===id);if(!goal)throw Object.assign(new Error('找不到指定目标'),{status:404});
  if(data.pageId&&data.pageId!==goal.pageId)throw Object.assign(new Error('目标已变化，请刷新后重试'),{status:409});
  const props={};
  if(Object.hasOwn(data,'name')){
    const name=cleanName(data.name);
    if(existing.some(g=>g.id!==id&&g.branch===goal.branch&&g.name.trim()===name))throw Object.assign(new Error('同一分支已存在此目标'),{status:409});
    props[GOAL_FIELDS.name]=titleValue(name);
  }
  if(Object.hasOwn(data,'category'))props[GOAL_FIELDS.parent]=textValue(CATEGORY_PREFIX+requireCategory('goals',data.category,categories,true));
  if(Object.hasOwn(data,'actual'))props['实际金额']={number:validateAmount(data.actual)};
  if(Object.hasOwn(data,'note'))props['说明']=textValue(cleanNote(data.note));
  if(Object.hasOwn(data,'budget'))props['预算人民币']={number:validateAmount(data.budget)};
  if(Object.hasOwn(data,'priority')){if(!['P0','待确认'].includes(data.priority))throw Object.assign(new Error('优先级无效'),{status:400});props['优先级']=selectValue(data.priority);}
  if(!Object.keys(props).length)throw Object.assign(new Error('没有可更新的字段'),{status:400});
  return asGoal(await notion(env,'/pages/'+goal.pageId,{method:'PATCH',body:{properties:props}}));
}
function buildPainProps({id,name,tier,links,note},goals){
  const mapped=links.map(x=>goals.find(g=>g.id===x)).filter(Boolean);
  if(mapped.length!==links.length)throw Object.assign(new Error('存在无效的关联目标编号'),{status:400});
  return {"痛点名称":titleValue(name),"编号":textValue(id),"层级":selectValue(TIER_NAMES[tier]||tier),"关联目标编号":textValue(links.filter(link=>GOAL_CODE.test(link)).join(', ')),"对应目标":{relation:mapped.map(g=>({id:g.pageId}))},"备注":textValue(note)};
}
async function createPain(env,data,existingPains,goals,categories){
  const category=requireCategory('pains',data.category??data.tier,categories);
  const tier=TIER_NAMES[category]?category:CATEGORY_PREFIX+category;
  const name=cleanName(data.name),note=cleanNote(data.note);
  if(existingPains.some(p=>p.name.trim()===name))throw Object.assign(new Error('同名痛点已登记'),{status:409});
  const links=Array.isArray(data.links)?[...new Set(data.links)]:[];
  if(links.length>40)throw Object.assign(new Error('一次关联目标过多'),{status:400});
  const id=nextPainCode(existingPains),props=buildPainProps({id,name,tier,links,note},goals);
  const page=await notion(env,'/pages',{method:'POST',body:{parent:{type:'data_source_id',data_source_id:env.NOTION_PAINS_SOURCE_ID},properties:props}});
  return asPain(page,Object.fromEntries(goals.map(g=>[g.pageId,g.id])));
}
async function patchPain(env,id,data,existingPains,goals,categories){
  const pain=existingPains.find(p=>p.id===id);if(!pain)throw Object.assign(new Error('找不到指定痛点'),{status:404});
  if(data.pageId&&data.pageId!==pain.pageId)throw Object.assign(new Error('痛点已变化，请刷新后重试'),{status:409});
  const props={};
  if(Object.hasOwn(data,'name')){
    const name=cleanName(data.name);
    if(existingPains.some(p=>p.id!==id&&p.name.trim()===name))throw Object.assign(new Error('同名痛点已登记'),{status:409});
    props[PAIN_FIELDS.name]=titleValue(name);
  }
  if(Object.hasOwn(data,'links')){
    if(!Array.isArray(data.links)||data.links.length>40)throw Object.assign(new Error('目标关联格式不正确'),{status:400});
    const links=[...new Set(data.links)];
    const payload=buildPainProps({id,name:pain.name,tier:pain.tier,links,note:pain.note},goals);
    props['关联目标编号']=payload['关联目标编号'];props['对应目标']=payload['对应目标'];
  }
  if(Object.hasOwn(data,'note'))props['备注']=textValue(cleanNote(data.note));
  if(Object.hasOwn(data,'category')||Object.hasOwn(data,'tier')){
    const category=requireCategory('pains',data.category??data.tier,categories,true);
    props['层级']=selectValue(TIER_NAMES[category]||CATEGORY_PREFIX+category);
  }
  if(!Object.keys(props).length)throw Object.assign(new Error('没有可更新的字段'),{status:400});
  const page=await notion(env,'/pages/'+pain.pageId,{method:'PATCH',body:{properties:props}});
  return asPain(page,Object.fromEntries(goals.map(g=>[g.pageId,g.id])));
}
function errorResponse(e){return fail(e.message||'服务端处理失败',e.status>=400&&e.status<=599?e.status:500);}
async function api(request,env,url){
  const method=request.method,path=url.pathname;
  const origin=request.headers.get('Origin');if((method==='DELETE'&&origin!==url.origin)||(origin&&origin!==url.origin))return fail('拒绝跨站登记请求',403);
  try{
    if(method==='GET'&&path==='/api/state')return json(await state(env));
    if(method==='GET'&&path==='/api/health'){
      const [g,p]=await Promise.all([queryAll(env,env.NOTION_GOALS_SOURCE_ID),queryAll(env,env.NOTION_PAINS_SOURCE_ID)]);
      const count=(pages,field)=>pages.filter(page=>!readPlain(page.properties?.[field]).startsWith(CATEGORY_PREFIX)).length;
      return json({ok:true,goalCount:count(g,GOAL_FIELDS.id),painCount:count(p,PAIN_FIELDS.id),storage:'notion',verified:true});
    }
    if(method==='PATCH'&&path==='/api/categories/goals/root'){
      const data=await bodyJson(request);
      const name=cleanName(data.name);
      const {goalRoot}=await state(env);
      await saveCategory(env,'goals',{...goalRoot,name,parent:'',order:0});
      return json({ok:true});
    }
    const categoryMatch=path.match(/^\/api\/categories\/(goals|pains)(?:\/([A-Za-z0-9-]+))?$/);
    if(categoryMatch){
      const [,kind,id]=categoryMatch;
      if((method==='POST'&&!id)||(['PATCH','DELETE'].includes(method)&&id)){
        const data=method==='DELETE'?{}:await bodyJson(request);
        await changeCategory(env,kind,id,method,data,await state(env));
        return json({ok:true},method==='POST'?201:200);
      }
    }
    if(method==='POST'&&path==='/api/goals'){
      const data=await bodyJson(request),current=await state(env);
      const goal=await createGoal(env,data,current.goals,current.hierarchy.goals);
      return json({ok:true,goal},201);
    }
    if(method==='POST'&&path==='/api/pains'){
      const data=await bodyJson(request),current=await state(env);
      const pain=await createPain(env,data,current.pains,current.goals,current.hierarchy.pains);
      return json({ok:true,pain},201);
    }
    const goalMatch=path.match(/^\/api\/goals\/(G00[123]-\d{2,}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/);
    if(method==='PATCH'&&goalMatch){const data=await bodyJson(request),current=await state(env);return json({ok:true,goal:await patchGoal(env,goalMatch[1],data,current.goals,current.hierarchy.goals)});}
    const painMatch=path.match(/^\/api\/pains\/(P\d{3,})$/);
    if(method==='PATCH'&&painMatch){const data=await bodyJson(request),current=await state(env);return json({ok:true,pain:await patchPain(env,painMatch[1],data,current.pains,current.goals,current.hierarchy.pains)});}
    if(method==='DELETE'&&(goalMatch||painMatch)){
      const {pageId}=await bodyJson(request);
      const current=await state(env);
      const id=(goalMatch||painMatch)[1];
      const item=(goalMatch?current.goals:current.pains).find(row=>row.id===id&&row.pageId===pageId);
      if(!item)return fail('记录已删除或已变化，请刷新后重试',404);
      if(goalMatch){
        const linked=current.pains.filter(p=>p.links.includes(id));
        if(linked.length)return fail('请先在对应痛点中取消关联：'+linked.map(p=>p.id).join('、'),409);
        if(current.goals.some(g=>g.parent===id))return fail('请先处理该目标的下级目标',409);
      }
      await notion(env,'/pages/'+item.pageId,{method:'PATCH',body:{in_trash:true}});
      return json({ok:true});
    }
    return fail('未找到此接口',404);
  }catch(e){return errorResponse(e);}
}
export default {
  async fetch(request,env,ctx){
    const publicAssets = new Set(['/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/.well-known/assetlinks.json']);
    const url=new URL(request.url);
    const path=url.pathname;
    if (path==='/view' || path==='/view/' || path==='/view/state') {
      if (!['GET','HEAD'].includes(request.method)) {
        return withHeaders(new Response(null,{status:405,headers:{Allow:'GET, HEAD'}}));
      }
      if (path==='/view') return withHeaders(Response.redirect(new URL('/view/',url),308));
      if (path==='/view/') {
        if (!env.ASSETS) return withHeaders(fail('网页资源暂不可用',503));
        return withHeaders(await env.ASSETS.fetch(new Request(new URL('/',url),request)));
      }
      try {
        const {goals,pains,hierarchy,goalRoot,...snapshot}=await state(env);
        const withoutPageId=({pageId,...record})=>record;
        const response=json({...snapshot,goalRoot:withoutPageId(goalRoot),hierarchy:{goals:hierarchy.goals.map(withoutPageId),pains:hierarchy.pains.map(withoutPageId)},goals:goals.map(withoutPageId),pains:pains.map(withoutPageId)});
        return withHeaders(request.method==='HEAD'?new Response(null,{headers:response.headers}):response);
      } catch {
        return withHeaders(fail('暂时无法读取目标数据，请稍后再试',503));
      }
    }
    if (publicAssets.has(path) && ['GET', 'HEAD'].includes(request.method) && env.ASSETS) {
      return withHeaders(await env.ASSETS.fetch(request));
    }
    const auth=await checkAccess(request,env);
    if(auth.error){const response=fail(auth.error,auth.code);return withHeaders(response);}
    if(url.pathname.startsWith('/api/'))return withHeaders(await api(request,env,url));
    if(request.method!=='GET'&&request.method!=='HEAD')return withHeaders(fail('仅允许读取网页资源',405));
    if(!env.ASSETS||typeof env.ASSETS.fetch!=='function')return withHeaders(fail('Cloudflare Pages 资源绑定未配置',503));
    return withHeaders(await env.ASSETS.fetch(request));
  }
};
