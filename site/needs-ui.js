'use strict';
window.needsUI = (() => {
  const key = 'wuxie-needs-v3';
  const settingsForm = el('needs-form');
  const controls = settingsForm.elements;
  const amountKeys = ['assets', 'debts', 'available', 'threshold'];
  const flagKeys = ['survival', 'autoUpgrade', 'autoDowngrade'];
  const textKeys = ['standard', 'customStandard', 'sortMode'];
  const format = new Intl.NumberFormat('zh-CN', {maximumFractionDigits: 2});
  const levels = {'P0-A':'P0 原生刚需','P0-B':'P0 动态刚需',P1:'P1 软需',P2:'P2 无需'};
  const moneyLabel = value => {
    if (value == null) return '待确认';
    const yuan = Number(value) / 100;
    if (Math.abs(yuan) >= 1e8) return format.format(yuan / 1e8) + ' 亿元';
    if (Math.abs(yuan) >= 1e4) return format.format(yuan / 1e4) + ' 万元';
    return format.format(yuan) + ' 元';
  };
  let settings = Needs.defaults(), saved = settings, model, filter = null;
  if (!readOnlyView) {
    try {
      const stored = localStorage.getItem(key);
      if (stored) saved = settings = Needs.validate(JSON.parse(stored));
    } catch (error) {
      el('needs-feedback').textContent = '无法读取已保存的设置：' + error.message;
    }
  }
  function persist(next, resetForm = false) {
    const validated = Needs.validate(next);
    localStorage.setItem(key, JSON.stringify(validated));
    settings = saved = validated;
    if (resetForm) fill();
  }
  function fill() {
    for (const key of [...amountKeys, ...textKeys]) controls[key].value = settings[key] ?? '';
    for (const key of flagKeys) controls[key].checked = settings[key];
  }
  function draft() {
    const next = {...settings};
    for (const key of amountKeys) next[key] = controls[key].value === '' ? null : controls[key].valueAsNumber;
    for (const key of textKeys) next[key] = controls[key].value;
    for (const key of flagKeys) next[key] = controls[key].checked;
    return Needs.validate(next);
  }
  function currentSnapshot() { return cloudSnapshot || {goals:[], pains:[]}; }
  function effectiveStandard() { return settings.standard === '自定义' ? settings.customStandard : settings.standard; }
  function category(pain) { return pain.dynamic.startsWith('P0') ? 'P0' : pain.dynamic; }
  function setFilter(next) {
    filter = filter === next ? null : next;
    painTierFilter = null;
    const matching = model.pains.filter(pain => !filter || category(pain) === filter);
    if (!matching.some(pain => pain.id === painFocus)) painFocus = matching[0]?.id ?? null;
    renderPain();
  }
  function renderMetrics() {
    const values = [
      ['个人资产总额',moneyLabel(settings.assets === null ? null : Needs.cents(settings.assets))],
      ['个人负债总额',moneyLabel(settings.debts === null ? null : Needs.cents(settings.debts))],
      ['个人净资产',moneyLabel(model.net)],
      ['可支配净资产',moneyLabel(settings.available === null ? null : Needs.cents(settings.available))],
      ['生存保障标准',moneyLabel(Needs.cents(settings.threshold))],
      ['温饱保障目标',settings.survival ? '已达成' : '未确认达成'],
      ['生存保障资金缺口',moneyLabel(model.gap)],
      ['生存保障率',settings.threshold === 0 ? '标准为 0，不计算' : model.rate == null ? '待确认' : format.format(model.rate * 100) + '%'],
      ['发展可用资金',moneyLabel(model.development)],
      ['已升级目标资金',moneyLabel(model.allocated)],
      ['剩余未分配资金',moneyLabel(model.remaining)],
      ['动态升级目标',model.held.length + ' 项']
    ];
    el('needs-metrics').replaceChildren(...values.map(([label,value]) => {
      const tile = document.createElement('div');
      const title = document.createElement('small');
      const number = document.createElement('strong');
      title.textContent = label; number.textContent = value;
      tile.append(title, number);
      return tile;
    }));
    el('needs-survival-link').hidden = !nodes.has('A');
    const thresholdCard = el('survival-threshold-display');
    if (thresholdCard) thresholdCard.textContent = moneyLabel(Needs.cents(settings.threshold));
    el('needs-notice').textContent = model.canUpgrade ? '温饱已达成，按执行顺序配置发展资金。' : '温饱目标已达成且可支配净资产超过标准时，才能自动升级。';
  }
  function renderPyramid() {
    const root = el('needs-pyramid');
    root.replaceChildren();
    const native = model.pains.filter(p => p.dynamic === 'P0-A').length;
    const upgraded = model.pains.filter(p => p.dynamic === 'P0-B').length;
    for (const [id,label,cls,description] of [
      ['P2','无需','needs-bin','无足轻重 · 不分配资金'],
      ['P1','软需','needs-step needs-soft',readOnlyView ? '按需求等级筛选' : '待配置目标资金 ' + moneyLabel(model.pending)],
      ['P0','刚需','needs-step needs-essential',readOnlyView ? '基础保障 ' + native + ' 项' : '原生刚需 ' + native + ' 项 · 动态升级 ' + upgraded + ' 项 · 基础待保障 ' + moneyLabel(model.nativeBudget) + ' · 已配置 ' + moneyLabel(model.allocated)]
    ]) {
      const option = button('', () => setFilter(id));
      option.className = cls;
      option.setAttribute('aria-pressed', String(filter === id));
      if (id === 'P2') option.innerHTML = '<svg viewBox="0 0 64 68" aria-hidden="true"><path d="M8 17 16 61Q32 69 48 61L56 17" fill="#6389a788" stroke="#8cc7df" stroke-width="2"/><ellipse cx="32" cy="17" rx="24" ry="9" fill="#244457" stroke="#a3d5e8" stroke-width="2"/><path d="m16 17 8-13 12 10 7-11 6 15Z" fill="#a3d5e8"/><text x="32" y="48" text-anchor="middle" fill="#65e3c2" font-size="24">♻</text></svg>';
      const heading = document.createElement('strong');
      heading.textContent = id + ' ' + label + ' · ' + model.pains.filter(pain => category(pain) === id).length + ' 项';
      const note = document.createElement('span');
      note.textContent = description;
      option.append(heading,note);
      root.append(option);
    }
  }
  function moveGoal(fromId, toId) {
    const order = model.candidates.map(goal => goal.id);
    const from = order.indexOf(fromId), to = order.indexOf(toId);
    if (from < 0 || to < 0 || from === to) return;
    order.splice(from,1);order.splice(to,0,fromId);
    try {
      persist({...settings,sortMode:'manual',order,held:model.held});
      controls.sortMode.value = 'manual';
      renderPain();
    } catch (error) { el('needs-feedback').textContent = error.message; }
  }
  function renderQueue() {
    const queue = el('needs-queue');
    queue.replaceChildren();
    if (!model.candidates.length) queue.textContent = '暂无待配置的软需目标。';
    let dragged;
    for (const [index,goal] of model.candidates.entries()) {
      const item = document.createElement('li');
      item.draggable = goal.cost !== null;
      const text = document.createElement('span');
      text.textContent = goal.name + ' · 剩余 ' + moneyLabel(goal.cost) + ' · 累计 ' + moneyLabel(goal.cumulative) + ' · ' + goal.status;
      const actions = document.createElement('span');
      const up = button('上移', () => moveGoal(goal.id,model.candidates[index-1]?.id));
      const down = button('下移', () => moveGoal(goal.id,model.candidates[index+1]?.id));
      up.disabled = index === 0 || goal.cost === null;
      down.disabled = model.candidates[index+1]?.cost == null || goal.cost === null;
      actions.append(up,down);
      item.ondragstart = event => { dragged=goal.id;event.dataTransfer?.setData('text/plain',goal.id); };
      item.ondragover = event => { if(goal.cost!==null)event.preventDefault(); };
      item.ondrop = event => { event.preventDefault();if(goal.cost!==null)moveGoal(dragged,goal.id); };
      item.append(text,actions);
      queue.append(item);
    }
  }
  function refresh() {
    model = Needs.calculate(settings,currentSnapshot());
    if (!readOnlyView) {
      renderMetrics();
      renderQueue();
      if (cloudSnapshot && settings === saved && JSON.stringify(saved.held) !== JSON.stringify(model.held)) {
        try { persist({...saved,held:model.held}); }
        catch { el('needs-feedback').textContent='无法保存本轮动态等级。'; }
      }
    }
    if (filter && !model.pains.some(pain => pain.id === painFocus && category(pain) === filter)) {
      painFocus = model.pains.find(pain => category(pain) === filter)?.id ?? null;
    }
    renderPyramid();
  }
  function detail(box,id) {
    const pain = model?.pains.find(p => p.id === id);
    if (!pain) return;
    const block = document.createElement('div');
    block.className = 'needs-record';
    const summary = document.createElement('p');
    summary.textContent = '初始 ' + levels[pain.original] + ' · 当前 ' + levels[pain.dynamic] + ' · 标准：' + effectiveStandard() + ' · ' + (pain.resolved ? '已解决' : '未标记解决');
    const reason = document.createElement('p');
    reason.textContent = pain.reason;
    block.append(summary,reason);
    if (!readOnlyView) {
      const list = document.createElement('ul');
      for (const id of pain.links) {
        const goal = model.goals.get(id);
        const item = document.createElement('li');
        item.textContent = goal.name + ' · 预算 ' + moneyLabel(goal.budget) + ' · 已确认资金 ' + moneyLabel(goal.fulfilled) + ' · 剩余 ' + moneyLabel(goal.cost) + ' · 累计 ' + moneyLabel(goal.cumulative) + ' · 已配置 ' + moneyLabel(goal.allocated);
        list.append(item);
      }
      block.append(list);
    }
    box.append(block);
  }
  function edit(fields,kind,item) {
    const known = settings[kind][item.id];
    const resolved = document.createElement('input');
    resolved.type = 'checkbox';resolved.checked = known?.resolved === true;
    const resolution = document.createElement('label');
    resolution.append(kind === 'pains' ? '痛点已解决' : '目标已完成',resolved);
    const adjustment = document.createElement('label');
    let read;
    if (kind === 'pains') {
      const select = document.createElement('select');
      for (const level of ['P0-A','P1','P2']) select.add(new Option(levels[level],level));
      const standard=Needs.standardKey(settings);
      select.value = Needs.levelFor(settings,item);
      adjustment.append('初始需求等级 · '+standard,select);
      read = () => ({
        level:standard==='生存'?select.value:(known?.level??(item.tier==='L0'?'P0-A':'P1')),
        byStandard:{...known?.byStandard,[standard]:select.value},
        resolved:resolved.checked
      });
    } else {
      const input = document.createElement('input');
      input.type='number';input.min=0;input.max=1e13;input.step='.01';
      input.value=known?.fulfilled ?? '';
      adjustment.append('已确认用于此目标的有效资金（元）',input);
      read = () => ({fulfilled:input.value===''?null:input.valueAsNumber,resolved:resolved.checked});
    }
    fields.append(adjustment,resolution);
    return () => {
      const value = read();
      return Needs.validate({...saved,[kind]:{...saved[kind],[item.id]:value}})[kind][item.id];
    };
  }
  if (!readOnlyView) {
    controls.standard.replaceChildren(...Needs.standards.map(label => new Option(label,label)));
    fill();
    const feedback = el('needs-feedback');
    settingsForm.oninput = () => {
      try { settings = draft(); feedback.textContent = '正在预览，保存后生效。'; renderPain(); }
      catch (error) { feedback.textContent = error.message; }
    };
    settingsForm.onsubmit = event => {
      event.preventDefault();
      try {
        const next = draft();
        persist({...next,held:Needs.calculate(next,currentSnapshot()).held});
        feedback.textContent = '已保存到此浏览器。';
        renderPain();
      } catch (error) { feedback.textContent = error.message; }
    };
    el('needs-survival-link').onclick = () => { if(nodes.has('A')){route('A');el('scene').scrollIntoView({block:'center'});} };
    el('needs-reset').onclick = () => {
      const next = Needs.defaults();
      try {
        persist({...next,pains:saved.pains,goals:saved.goals},true);
        feedback.textContent = '已恢复默认资产设置，保留记录标注。';
        renderPain();
      } catch (error) { feedback.textContent = error.message; }
    };
  }
  return {
    refresh, detail, edit, atlasData: () => model, clear: () => { filter=null; },
    level: id => levels[model?.pains.find(pain => pain.id === id)?.dynamic] || '待归类',
    includes: id => !filter || model.pains.some(pain => pain.id === id && category(pain) === filter),
    saveRecord: (kind,id,value) => persist({...saved,[kind]:{...saved[kind],[id]:value}}),
    backup: () => saved,
    restore: data => { persist(data,true);renderPain(); }
  };
})();
renderPain();
