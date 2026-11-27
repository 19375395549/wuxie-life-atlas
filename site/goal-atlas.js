'use strict';
const AtlasGeometry = (() => {
  const known = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  function radius(amount, max, mode, minRadius, maxRadius) {
    if (mode === 'uniform') return (minRadius + maxRadius) / 2;
    if (!known(amount) || amount === 0) return minRadius;
    if (!(max > 0)) return minRadius;
    const fraction = mode === 'area' ? Math.sqrt(amount / max) : Math.log1p(amount) / Math.log1p(max);
    return mode === 'area' ? Math.max(minRadius,maxRadius * fraction) : minRadius + (maxRadius-minRadius) * fraction;
  }
  function distanceRatio(amount,max) {
    if(!known(amount))return 1.06;
    return 1-0.76*(max>0?Math.log1p(amount)/Math.log1p(max):0);
  }
  function childGraph(tree, records) {
    const graph = new Map([...tree].map(([id,node]) => [id,new Set(node.children.map(child => child.id))]));
    for (const row of records) {
      if (!graph.has(row.id)) continue;
      for (const parent of row.parentIds || []) {
        if (!graph.has(parent)) continue;
        const seen = new Set();
        const pending = [row.id];
        while (pending.length) {
          const current = pending.pop();
          if (seen.has(current)) continue;
          seen.add(current);
          pending.push(...graph.get(current));
        }
        if (!seen.has(parent)) graph.get(parent).add(row.id);
      }
    }
    return graph;
  }
  return {known,radius,distanceRatio,childGraph};
})();
if (typeof module !== 'undefined') module.exports = AtlasGeometry;
if (typeof window !== 'undefined') startGoalAtlas();

function startGoalAtlas() {
  const canvas = el('scene').querySelector('canvas'), ctx = canvas.getContext('2d');
  if (!ctx) {
    el('atlas-status').textContent = '此浏览器暂不支持画布，可从目标登记簿查看。';
    return;
  }
  const media = matchMedia('(prefers-reduced-motion: reduce)');
  const memory = 'wuxie-goal-atlas-v1';
  const colors = {G001:'#81e5c4',G002:'#f2b978',G003:'#91b1ff'};
  const defaults = {view:'nebula',scale:'log',bubbleScale:'log',speed:1,low:false,zoom:1,bubbleZoom:1,angle:0};
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(memory) || '{}') || {}; } catch {}
  const options = {...defaults};
  for (const key of ['scale','bubbleScale']) if (['log','area','uniform'].includes(saved[key])) options[key] = saved[key];
  if (['nebula','bubble'].includes(saved.view)) options.view=saved.view;
  if ([0.5,1,2].includes(saved.speed)) options.speed=saved.speed;
  if (typeof saved.low==='boolean') options.low=saved.low;
  for (const key of ['zoom','bubbleZoom']) if (typeof saved[key]==='number'&&saved[key]>=0.65&&saved[key]<=4) options[key]=saved[key];
  if (Number.isFinite(saved.angle)) options.angle=saved.angle%(2*Math.PI);
  let selection = selected.id, trail=[root.id], page=0, recordsById, graph, maxAmount, visibleRows, orbitRows=[], orbitBranches=[], orbitLinks=[], hits=[];
  let frame=0, lastTime=null, visible=false, playing=!media.matches, hovered=null, transition=0;
  let toolbarHover=false, focusTarget=null, pan={x:0,y:0}, pointers=new Map(), pinchDistance=0, dragged=false;

  const search=el('atlas-search'), category=el('atlas-category'), need=el('atlas-need'), amountMode=el('atlas-amount');
  const scale=el('atlas-scale'), speed=el('atlas-speed'), toggle=el('toggle-orbit'), accessible=el('atlas-accessible');
  const isNebula=()=>options.view==='nebula';
  function store() { try { localStorage.setItem(memory,JSON.stringify(options)); } catch {} }
  function selectedScale() { return isNebula()?options.scale:options.bubbleScale; }
  function zoomKey() { return isNebula()?'zoom':'bubbleZoom'; }
  function graphChildren(id) { return [...(graph?.get(id) || [])]; }
  function budgetText(value) {
    return AtlasGeometry.known(value) ? (value>=1e8?(value/1e8).toLocaleString('zh-CN',{maximumFractionDigits:2})+' 亿元':value>=1e4?(value/1e4).toLocaleString('zh-CN',{maximumFractionDigits:2})+' 万元':money(value)) : '金额待确认';
  }
  function makeRecords() {
    const rows=cloudSnapshot?.goals || [];
    const calculated=window.needsUI?.atlasData();
    return new Map(rows.map((row,index)=>{
      const original=calculated?.pains.filter(pain=>pain.links.includes(row.id)) || [];
      const related=(cloudSnapshot?.pains||[]).filter(pain=>pain.links?.includes(row.id));
      const level=original.some(pain=>pain.original==='P0-A')?'P0-A':
        original.some(pain=>pain.dynamic==='P0-B')?'P0-B':
        original.length&&original.every(pain=>pain.original==='P2')?'P2':'P1';
      const base=level==='P0-A'?'P0-A':level==='P2'?'P2':'P1';
      const computed=calculated?.goals.get(row.id);
      const progress = computed?.resolved ? 1 :
        row.budget>0&&Number.isFinite(computed?.fulfilled) ? Math.min(1,computed.fulfilled/100/row.budget) : null;
      return [row.id,{...row,level,base,pains:related,index,progress,resolved:computed?.resolved===true,
        cost:computed?.cost==null?null:computed.cost/100,allocated:computed?computed.allocated/100:null}];
    }));
  }
  function matches(row) {
    if(category.value.startsWith('node:')){
      const target=category.value.slice(5);
      const pending=[target],seen=new Set();
      while(pending.length){
        const id=pending.pop();
        if(seen.has(id))continue;
        seen.add(id);
        pending.push(...graphChildren(id));
      }
      if(!seen.has(row.id))return false;
    }else if(category.value&&row.branch!==category.value) return false;
    const level=need.value;
    if (!level&&row.level==='P2') return false;
    if (level&&level!=='all'&&(level==='P0'?!row.level.startsWith('P0'):row.level!==level)) return false;
    const query=search.value.trim().toLowerCase();
    return !query||(row.name+' '+row.id).toLowerCase().includes(query);
  }
  function refresh() {
    recordsById=makeRecords();
    graph=AtlasGeometry.childGraph(nodes,[...recordsById.values()]);
    const previousCategory=category.value;
    for(const option of [...category.options])if(option.value.startsWith('node:'))option.remove();
    for(const node of nodes.values())if(node.categoryNode)category.add(new Option('分类 · '+node.name,'node:'+node.id));
    if([...category.options].some(option=>option.value===previousCategory))category.value=previousCategory;
    visibleRows=[...recordsById.values()].filter(matches);
    maxAmount=Math.max(0,...[...recordsById.values()].map(row=>row[amountMode.value]??0));
    const included=new Set(visibleRows.map(row=>row.id));
    const topChildren=graphChildren(root.id);
    const branchIds=topChildren.filter(id=>!recordsById.has(id));
    const lanes=new Map(branchIds.map((id,index)=>[id,index]));
    const fullRows=[...recordsById.values()].sort((a,b)=>a.id.localeCompare(b.id));
    const grouped=new Map();
    function topBranch(row){
      let id=row.category;
      const visited=new Set();
      while(id&&id!==root.id&&!visited.has(id)){
        if(lanes.has(id))return id;
        visited.add(id);
        id=nodes.get(id)?.parent;
      }
      return lanes.has(row.branch)?row.branch:root.id;
    }
    for(const row of fullRows){
      const branch=topBranch(row);
      if(!grouped.has(branch))grouped.set(branch,[]);
      grouped.get(branch).push(row);
    }
    const laneCount=Math.max(1,branchIds.length+Number(grouped.has(root.id)));
    const turn=2*Math.PI/laneCount;
    orbitBranches=branchIds.map((id,index)=>({id,angle:-Math.PI/2+index*turn}));
    orbitRows=[...grouped].flatMap(([branch,rows])=>rows.map((row,index)=>{
      const lane=lanes.get(branch)??branchIds.length;
      const fraction=((index+1)*0.61803398875)%1;
      return {
        row,branch,visible:included.has(row.id),
        angle:-Math.PI/2+(lane+(fraction-.5)*0.94)*turn,
        unit:AtlasGeometry.radius(row[amountMode.value],maxAmount,options.scale,0,1),
        distance:AtlasGeometry.distanceRatio(row[amountMode.value],maxAmount)
      };
    }));
    const displayed=new Set([root.id,...branchIds,...visibleRows.map(row=>row.id)]);
    orbitLinks=orbitBranches.map(branch=>[root.id,branch.id]);
    for(const item of orbitRows.filter(item=>item.visible)){
      const {row,branch}=item;
      const main=displayed.has(row.category)&&row.category!==row.id?row.category:branch;
      orbitLinks.push([main,row.id]);
      for(const parent of row.parentIds||[])if(parent!==main&&displayed.has(parent))orbitLinks.push([parent,row.id]);
    }
    if(!nodes.has(selection))selection=root.id;
    normalizeTrail();
    updateControls();
    paint(performance.now());
    schedule();
  }
  function normalizeTrail() {
    const valid=[root.id];
    for(const id of trail.slice(1)){
      if(!graphChildren(valid.at(-1)).includes(id)||valid.includes(id))break;
      valid.push(id);
    }
    trail=valid;
  }
  function bubbleChildren() {
    return graphChildren(trail.at(-1)).filter(id=>!trail.includes(id)&&(!recordsById.has(id)||matches(recordsById.get(id))));
  }
  function updateControls() {
    el('atlas-nebula').setAttribute('aria-pressed',String(isNebula()));
    el('atlas-bubble').setAttribute('aria-pressed',String(!isNebula()));
    el('atlas-animation').hidden=!isNebula();
    el('atlas-navigation').hidden=isNebula();
    scale.value=selectedScale();speed.value=String(options.speed);
    el('atlas-low').checked=options.low;
    toggle.textContent=playing?'暂停旋转':'播放旋转';
    const children=bubbleChildren(), totalPages=Math.max(1,Math.ceil(children.length/3));
    page=Math.min(page,totalPages-1);
    el('atlas-prev').hidden=el('atlas-next').hidden=totalPages===1;
    el('atlas-prev').disabled=page===0;el('atlas-next').disabled=page>=totalPages-1;
    el('back').disabled=trail.length===1;
    el('atlas-crumb').replaceChildren(...trail.map((id,index)=>button(nodes.get(id)?.name||id,()=>navigate(trail.slice(0,index+1)))));
    const visibleIds=isNebula()?[root.id,...orbitBranches.map(branch=>branch.id),...visibleRows.map(row=>row.id)]:[trail.at(-1),...children.slice(page*3,page*3+3)];
    accessible.replaceChildren(new Option('选择节点',''),...visibleIds.map(id=>new Option(nodes.get(id)?.name||id,id)));
    accessible.value=visibleIds.includes(selection)?selection:'';
    const hiddenSelection=isNebula()&&recordsById.has(selection)&&!visibleIds.includes(selection);
    el('atlas-status').textContent=(isNebula()?visibleRows.length+' 项目标 · '+({log:'对数',area:'面积比例（含最小标记）',uniform:'统一'}[options.scale]):children.length+' 个下级 · '+(page+1)+'/'+totalPages+' 组')
      +(hiddenSelection?' · 已选目标被筛选隐藏':'');
  }
  function go(id) {
    selection=id;
    route(id);
  }
  function navigate(next) {
    trail=next;page=0;transition=performance.now();go(next.at(-1));
  }
  function findPath(id) {
    const pending=[root.id], parents=new Map([[root.id,null]]);
    for (let index=0;index<pending.length;index++) {
      const current=pending[index];
      if(current===id){
        const path=[];
        for(let entry=id;entry!==null;entry=parents.get(entry))path.unshift(entry);
        return path;
      }
      for(const child of graphChildren(current)){
        if(!parents.has(child)){parents.set(child,current);pending.push(child);}
      }
    }
    return null;
  }
  function follow(id) {
    if(selection===id)return;
    selection=id;
    if(isNebula()||id===trail.at(-1))return;
    const path=findPath(id);
    if(!path)return;
    if(graphChildren(id).length){trail=path;page=0;}
    else if(path.length>1){
      trail=path.slice(0,-1);
      page=Math.max(0,Math.floor(bubbleChildren().indexOf(id)/3));
    }
  }
  function choose(id) {
    if(!id)return;
    if(!isNebula()&&id!==trail.at(-1)&&graphChildren(id).some(child=>!trail.includes(child))){
      navigate([...trail,id]);
    }else go(id);
  }
  function locate() {
    const query=search.value.trim().toLowerCase();
    const found=[...recordsById.values()].find(row=>row.id.toLowerCase()===query) ||
      [...recordsById.values()].find(row=>row.name.toLowerCase().includes(query)&&query) ||
      [...nodes.values()].find(node=>node.name.toLowerCase().includes(query)&&query);
    if(!found){el('atlas-status').textContent='未找到目标';return;}
    if(!isNebula())selection=null;
    route(found.id);
    if(isNebula()){focusTarget=found.id;redraw();}
    const hidden=recordsById.has(found.id)&&!matches(recordsById.get(found.id));
    if(hidden)el('atlas-status').textContent='已选目标被筛选隐藏，可在详情中解除筛选。';
  }
  function orbitalPositions(width,height) {
    const size=Math.min(width,height),zoom=options.zoom;
    const maxRadius=Math.max(6,Math.min(20,size/Math.max(17,Math.sqrt(orbitRows.length)*4.4)))*zoom;
    const centerX=width/2+pan.x,centerY=height/2+pan.y;
    const polar=(angle,distance)=>({
      x:centerX+Math.cos(angle+options.angle)*size*distance*zoom,
      y:centerY+Math.sin(angle+options.angle)*size*distance*zoom
    });
    const marks=orbitRows.filter(item=>item.visible).map(({row,angle,unit,distance})=>{
      const minimum=Math.min(maxRadius,4*zoom);
      const radius=options.scale==='area'?Math.max(minimum,maxRadius*unit):minimum+(maxRadius-minimum)*unit;
      return {id:row.id,...polar(angle,distance*0.43),r:radius,row};
    });
    for(const branch of orbitBranches){
      marks.push({id:branch.id,...polar(branch.angle,0.23),r:Math.min(13,9*zoom),branch:true});
    }
    marks.push({id:root.id,x:centerX,y:centerY,r:15});
    return marks;
  }
  function bubblePositions(width,height,time) {
    const center=trail.at(-1),children=bubbleChildren().slice(page*3,page*3+3);
    const off=Math.min(width,height)*0.37*options.bubbleZoom;
    const ease=media.matches||!transition?1:Math.min(1,(time-transition)/320);
    const motion=1-Math.pow(1-Math.max(0,ease),3);
    const cx=width/2,cy=height/2;
    const valueFor=id=>{
      if(recordsById.has(id))return recordsById.get(id)[amountMode.value];
      if(amountMode.value!=='budget')return null;
      if(id==='G001')return recordsById.get('G001-01')?.budget;
      return nodes.get(id)?.budget;
    };
    const localMax=Math.max(0,...children.map(id=>valueFor(id)??0));
    const marks=[{id:center,x:cx,y:cy,r:Math.min(48,width*0.12),row:recordsById.get(center)}];
    children.forEach((id,index)=>{
      const angle=-Math.PI/2+index*2*Math.PI/Math.max(3,children.length);
      const row=recordsById.get(id);
      const amount=valueFor(id);
      const radius=AtlasGeometry.radius(amount,localMax,options.bubbleScale,17,40);
      const distance=(0.55+AtlasGeometry.distanceRatio(amount,localMax)*0.45)*off*motion;
      marks.push({id,x:cx+Math.cos(angle)*distance,y:cy+Math.sin(angle)*distance,r:radius,row,amount});
    });
    return marks;
  }
  function paint(time) {
    const width=canvas.clientWidth,height=canvas.clientHeight;
    if(!width||!height||!graph)return;
    const ratio=Math.min(devicePixelRatio||1,options.low?1:1.75);
    const pixelWidth=Math.round(width*ratio),pixelHeight=Math.round(height*ratio);
    if(canvas.width!==pixelWidth||canvas.height!==pixelHeight){canvas.width=pixelWidth;canvas.height=pixelHeight;}
    ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,width,height);
    const circle=(x,y,r)=>{ctx.beginPath();ctx.arc(x,y,Math.max(0.1,r),0,Math.PI*2);};
    const centerX=width/2+pan.x,centerY=height/2+pan.y;
    if(isNebula()){
      ctx.fillStyle='#7594b166';
      for(let i=0;i<(options.low?36:95);i++)ctx.fillRect((i*997%977)*width/977,(i*617%991)*height/991,1,i%7===0?2:1);
      for(const size of [0.17,0.3,0.43]){
        ctx.beginPath();ctx.ellipse(centerX,centerY,Math.min(width,height)*size*options.zoom,Math.min(width,height)*size*options.zoom,0,0,Math.PI*2);
        ctx.strokeStyle='#41617a55';ctx.stroke();
      }
    }
    let marks=isNebula()?orbitalPositions(width,height):bubblePositions(width,height,time);
    if(isNebula()&&focusTarget){
      const target=marks.find(mark=>mark.id===focusTarget);
      if(target){
        const dx=width/2-target.x,dy=height/2-target.y;
        const factor=media.matches?1:0.19;
        pan.x+=dx*factor;pan.y+=dy*factor;
        marks=orbitalPositions(width,height);
        if(Math.hypot(dx,dy)<2)focusTarget=null;
      }else focusTarget=null;
    }
    if(isNebula()){
      const byId=new Map(marks.map(mark=>[mark.id,mark]));
      for(const [parent,id] of orbitLinks){
        const a=byId.get(parent),b=byId.get(id);
        if(!a||!b)continue;
        const branch=nodes.get(parent)?.branch||parent;
        const line=colors[b.row?.branch]||colors[branch]||'#70bfd2';
        ctx.strokeStyle=line+(id===selection||parent===selection&&parent!==root.id?'8a':'35');
        ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();
      }
    }else for(const mark of marks.slice(1)){
      ctx.beginPath();ctx.moveTo(marks[0].x,marks[0].y);ctx.lineTo(mark.x,mark.y);ctx.strokeStyle='#61a2b17b';ctx.stroke();
    }
    const boxes=[];
    hits=[];
    ctx.font='12px system-ui';
    for(const mark of marks){
      const {x,y,r,row,id}=mark;
      if(x+r<0||x-r>width||y+r<0||y-r>height)continue;
      const color=row?.level==='P2'?'#8998aa':colors[row?.branch||id]||'#73c7dc';
      if(!options.low){
        const glow=ctx.createRadialGradient(x,y,0,x,y,r*2.2);
        glow.addColorStop(0,color+(row?.level.startsWith('P0')?'a0':'52'));glow.addColorStop(1,color+'00');
        circle(x,y,r*2.2);ctx.fillStyle=glow;ctx.fill();
      }
      const sphere=ctx.createRadialGradient(x-r*.36,y-r*.36,0,x,y,r);
      sphere.addColorStop(0,'#f4ffff');sphere.addColorStop(.28,color);sphere.addColorStop(1,'#172f49');
      circle(x,y,r);ctx.fillStyle=sphere;ctx.fill();
      if(row?.progress!==null&&row?.progress!==undefined){
        ctx.beginPath();ctx.arc(x,y,r+4,-Math.PI/2,-Math.PI/2+Math.PI*2*row.progress);
        ctx.strokeStyle='#a8ffe0';ctx.stroke();
      }
      if(id===root.id&&isNebula()){
        ctx.beginPath();ctx.ellipse(x,y,r*1.65,r*0.56,-0.4,0,Math.PI*2);
        ctx.strokeStyle='#9edddb9c';ctx.stroke();
      }
      if(selection===id||hovered===id){circle(x,y,r+6);ctx.strokeStyle='#c9fcff';ctx.stroke();}
      hits.push({...mark,r:Math.max(10,r+3)});
    }
    const labels=[...marks].sort((a,b)=>Number(b.id===selection||b.id===hovered)-Number(a.id===selection||a.id===hovered));
    for(const mark of labels){
      if(mark.x<0||mark.x>width||mark.y<0||mark.y>height)continue;
      const forced=mark.id===selection||mark.id===hovered;
      if(isNebula()&&!forced&&!mark.branch&&mark.id!==root.id)continue;
      const name=nodes.get(mark.id)?.name||mark.id;
      const caption=(mark.row?.resolved?'✓ ':'')+(name.length>14?name.slice(0,14)+'…':name);
      const value=mark.row?budgetText(mark.row[amountMode.value]):('amount' in mark?(nodes.get(mark.id)?.categoryNode&&AtlasGeometry.known(mark.amount)?'分类口径 · ':'')+budgetText(mark.amount):'');
      const widthText=Math.max(ctx.measureText(caption).width,ctx.measureText(value).width)+10;
      const heightText=value?32:17;
      const x=Math.max(0,Math.min(width-widthText,mark.x-widthText/2));
      const y=Math.max(0,Math.min(height-heightText,mark.y+mark.r+5));
      if(!forced&&boxes.some(box=>x<box.x+box.w&&x+widthText>box.x&&y<box.y+box.h&&y+heightText>box.y))continue;
      boxes.push({x,y,w:widthText,h:heightText});
      ctx.fillStyle='#101e2eea';ctx.fillRect(x,y,widthText,heightText);
      ctx.fillStyle='#daeff8';ctx.textAlign='center';ctx.fillText(caption,x+widthText/2,y+12);
      if(value){ctx.fillStyle='#97b6ce';ctx.fillText(value,x+widthText/2,y+27);}
      hits.push({id:mark.id,row:mark.row,box:{x,y,w:widthText,h:heightText}});
    }
  }
  function schedule() {
    const animation=isNebula()?(playing&&!hovered&&!toolbarHover&&!pointers.size&&!el('record-editor').open&&!el('category-editor').open||focusTarget):transition&&performance.now()-transition<330&&!media.matches;
    if(visible&&!document.hidden&&animation){
      if(!frame)frame=requestAnimationFrame(tick);
    }else if(frame){
      cancelAnimationFrame(frame);frame=0;lastTime=null;
    }
  }
  function tick(time) {
    frame=0;
    const interval=options.low?65:28;
    if(lastTime===null)lastTime=time-interval;
    if(time-lastTime>=interval){
      if(isNebula()&&playing&&!focusTarget&&!hovered&&!toolbarHover&&!pointers.size&&!el('record-editor').open&&!el('category-editor').open)
        options.angle=(options.angle+Math.min(90,time-lastTime)*options.speed*2*Math.PI/120000)%(2*Math.PI);
      paint(time);lastTime=time;
    }
    schedule();
  }
  function local(event) {
    const bounds=canvas.getBoundingClientRect();
    return {x:event.clientX-bounds.left,y:event.clientY-bounds.top};
  }
  function hit(event) {
    const {x,y}=local(event);
    return [...hits].reverse().find(mark=>mark.box?x>=mark.box.x&&x<=mark.box.x+mark.box.w&&y>=mark.box.y&&y<=mark.box.y+mark.box.h:Math.hypot(x-mark.x,y-mark.y)<=mark.r);
  }
  function redraw(){paint(performance.now());schedule();}
  function zoomBy(factor){options[zoomKey()]=Math.max(.65,Math.min(4,options[zoomKey()]*factor));store();redraw();}
  canvas.onpointerdown=event=>{
    if(!pointers.size){dragged=false;pinchDistance=0;}
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId,local(event));focusTarget=null;
    if(pointers.size>1)dragged=true;
    schedule();
  };
  canvas.onpointermove=event=>{
    const point=local(event),previous=pointers.get(event.pointerId);
    if(previous){
      pointers.set(event.pointerId,point);
      if(pointers.size===2){
        const [a,b]=pointers.values(),distance=Math.hypot(a.x-b.x,a.y-b.y);
        if(pinchDistance>0&&distance>0)zoomBy(distance/pinchDistance);
        pinchDistance=distance;return;
      }
      const dx=point.x-previous.x,dy=point.y-previous.y;
      if(Math.hypot(dx,dy)>1.5)dragged=true;
      if(dragged&&isNebula()){options.angle+=dx*0.009;pan.y+=dy;redraw();}
    }else if(event.pointerType!=='touch'){
      const item=hit(event);hovered=item?.id??null;
      const info=el('atlas-hover');info.hidden=!item;
      if(item)info.textContent=(nodes.get(item.id)?.name||item.id)+(item.row?' · '+budgetText(item.row[amountMode.value])+' · '+branchName(item.row.branch)+' · '+item.row.level:'');
      redraw();
    }
  };
  function endPointer(event,cancel){
    const tracked=pointers.delete(event.pointerId);
    if(tracked&&!cancel&&!dragged&&!pointers.size){
      const item=hit(event);
      if(item)choose(item.id);
      else if(isNebula())go(root.id);
    }
    store();redraw();
  }
  canvas.onpointerup=event=>endPointer(event,false);
  canvas.onpointercancel=event=>endPointer(event,true);
  canvas.onpointerleave=()=>{hovered=null;el('atlas-hover').hidden=true;redraw();};
  canvas.ondblclick=event=>{
    const item=hit(event);
    if(item&&isNebula()){focusTarget=item.id;redraw();}
  };
  canvas.addEventListener('wheel',event=>{event.preventDefault();zoomBy(event.deltaY<0?1.08:1/1.08);},{passive:false});
  function branchName(branch) {
    return nodes.get(branch)?.name || ({G001:'现金财富',G002:'生活消费',G003:'投资本金'}[branch]??'未归类');
  }
  function detail(panel,node) {
    const row=recordsById?.get(node.id);
    const section=document.createElement('section');
    section.className='needs-record';
    if(node===root){
      const summary=cloudSnapshot?.summary;
      const cash=recordsById?.get('G001-01')?.budget;
      const totals=[
        '目标总览 · '+(summary?.goalCount??0)+' 项',
        '现金财富目标 · '+budgetText(cash),
        '终身消费预算 · '+budgetText(summary?.consumption),
        '投资计划本金 · '+budgetText(summary?.investment)
      ];
      for(const value of totals){const line=document.createElement('div');line.textContent=value;section.append(line);}
      if(!readOnlyView)section.append(button('重命名目标树',()=>openCategoryEditor('goals',root.id)));
    }
    if(row){
      const descriptions=[
        ['编号',row.id.length===36?'未编号':row.id],['类别',branchName(row.branch)],
        ['上级',[...new Set([row.category,...(row.parentIds||[])])].map(id=>nodes.get(id)?.name).filter(Boolean).join('、')||'目标树根目录'],
        ['目标预算',budgetText(row.budget)],['实际登记',budgetText(row.actual)],
        ['剩余所需',budgetText(row.cost)],['已配置',readOnlyView?'公开页不展示私人资金配置':budgetText(row.allocated)],
        ['完成状态',row.resolved?'已完成':row.progress==null?'进度待确认':Math.round(row.progress*100)+'%'],
        ['初始 / 动态等级',row.base+' / '+row.level]
      ];
      for(const [name,value] of descriptions){
        const line=document.createElement('div');line.textContent=name+' · '+value;section.append(line);
      }
      if(row.pains.length){
        const label=document.createElement('p');label.textContent='关联痛点';
        section.append(label,...row.pains.map(pain=>button(pain.name,()=>{
          window.needsUI?.clear();painTierFilter=null;painFocus=pain.id;renderPain();
          el('pain-detail').scrollIntoView({block:'center'});
        })));
      }
      if(!isNebula()&&node.id!==trail.at(-1)&&!bubbleChildren().slice(page*3,page*3+3).includes(node.id)){
      section.append(button('定位已选目标',()=>{selection=null;route(node.id);}));
    }
    if(!matches(row))section.append(button('解除筛选',()=>{search.value=category.value='';need.value='all';refresh();window.detail();}));
    }else if(node.categoryNode&&node.budget!=null){
      const summary=document.createElement('p');summary.textContent='分类汇总 · '+budgetText(node.budget);section.append(summary);
    }
    if(!readOnlyView&&(row||node.categoryNode))section.append(button(row?'编辑目标':'编辑分类',()=>row?openRecordEditor('goals',row.id):openCategoryEditor('goals',node.id)));
    if(section.children.length)panel.append(section);
  }
  function switchView(next){
    options.view=next;focusTarget=null;hovered=null;lastTime=null;
    el('atlas-hover').hidden=true;
    store();refresh();window.detail();
  }
  el('atlas-nebula').onclick=()=>switchView('nebula');
  el('atlas-bubble').onclick=()=>switchView('bubble');
  el('home').onclick=()=>navigate([root.id]);
  el('back').onclick=()=>{if(trail.length>1)navigate(trail.slice(0,-1));};
  el('atlas-prev').onclick=()=>{page=Math.max(0,page-1);refresh();};
  el('atlas-next').onclick=()=>{page++;refresh();};
  el('atlas-locate').onclick=locate;
  search.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();locate();}};
  for(const control of [search,category,need,amountMode])control.oninput=()=>{page=0;refresh();window.detail();};
  scale.onchange=()=>{options[isNebula()?'scale':'bubbleScale']=scale.value;store();refresh();};
  speed.onchange=()=>{options.speed=Number(speed.value);store();};
  toggle.onclick=()=>{playing=!playing;lastTime=null;updateControls();schedule();};
  el('atlas-low').onchange=event=>{options.low=event.target.checked;store();redraw();};
  el('plus').onclick=()=>zoomBy(1.15);
  el('minus').onclick=()=>zoomBy(1/1.15);
  el('reset').onclick=()=>{options.zoom=1;options.angle=0;pan={x:0,y:0};focusTarget=null;store();redraw();};
  accessible.onchange=()=>choose(accessible.value);
  const layout=el('atlas-layout');
  for(const toolbar of layout.querySelectorAll('.atlas-tools')){
    toolbar.addEventListener('pointerenter',event=>{if(event.pointerType==='mouse'){toolbarHover=true;schedule();}});
    toolbar.addEventListener('pointerleave',()=>{toolbarHover=false;schedule();});
  }
  el('atlas-detail-toggle').onclick=event=>{
    const collapsed=layout.classList.toggle('detail-collapsed');
    event.target.setAttribute('aria-expanded',String(!collapsed));
    event.target.textContent=collapsed?'展开详情':'折叠详情';
  };
  el('atlas-full').onclick=async()=>{
    try { if(document.fullscreenElement)await document.exitFullscreen();else await layout.requestFullscreen(); }
    catch { el('atlas-status').textContent='此浏览器暂不支持此处全屏。'; }
  };
  document.addEventListener('fullscreenchange',()=>{el('atlas-full').textContent=document.fullscreenElement?'退出全屏':'全屏';redraw();});
  document.addEventListener('visibilitychange',schedule);
  media.addEventListener('change',event=>{playing=!event.matches;updateControls();redraw();});
  for(const id of ['record-editor','category-editor'])el(id).addEventListener('close',schedule);
  new ResizeObserver(redraw).observe(canvas);
  new IntersectionObserver(([entry])=>{visible=entry.isIntersecting;redraw();}).observe(canvas);
  window.goalAtlas={refresh,follow,detail,level:id=>recordsById?.get(id)?.level||''};
  refresh();
  window.detail();
}
