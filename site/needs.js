'use strict';
const Needs = (() => {
  const standards = ['生存', '财富', '幸福', '健康', '职业发展', '自定义'];
  const sorts = ['amountAsc', 'amountDesc', 'manual'];
  const levels = ['P0-A', 'P1', 'P2'];
  const limit = 10 ** 13;
  const defaults = () => ({
    version: 3, assets: null, debts: null, available: null, threshold: 1000000,
    survival: false, standard: '生存', customStandard: '', sortMode: 'amountAsc',
    autoUpgrade: true, autoDowngrade: true, pains: {}, goals: {}, order: [], held: []
  });
  const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= limit;
  const sumResult = value => value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
  const cents = value => Math.round((value + Number.EPSILON * value) * 100);
  const isMap = value => value && typeof value === 'object' && !Array.isArray(value);
  const id = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(value);
  const standardKey = settings => settings.standard === '自定义' ? '自定义：'+settings.customStandard.trim() : settings.standard;
  const levelFor = (settings,pain) => {
    const defaultsToNative = pain.tier === 'L0';
    const saved = settings.pains[pain.id];
    const standard = standardKey(settings);
    return saved?.byStandard?.[standard] ?? (standard === '生存' ? saved?.level : undefined) ?? (defaultsToNative ? 'P0-A' : 'P1');
  };
  function validate(data) {
    if (!isMap(data) || data.version !== 3) throw Error('不支持此需求模型版本');
    const result = defaults();
    for (const key of ['assets', 'debts', 'available', 'threshold']) {
      if (data[key] === null && key !== 'threshold') continue;
      if (!amount(data[key])) throw Error('金额必须是有效的非负人民币金额');
      result[key] = cents(data[key]) / 100;
    }
    for (const key of ['survival', 'autoUpgrade', 'autoDowngrade']) {
      if (typeof data[key] !== 'boolean') throw Error('设置格式无效');
      result[key] = data[key];
    }
    if (!standards.includes(data.standard) || !sorts.includes(data.sortMode) || typeof data.customStandard !== 'string' || data.customStandard.length > 100) throw Error('衡量标准或排序无效');
    if (data.standard === '自定义' && !data.customStandard.trim()) throw Error('请填写自定义衡量标准');
    Object.assign(result, {standard: data.standard, customStandard: data.customStandard, sortMode: data.sortMode});
    for (const key of ['order', 'held']) {
      if (!Array.isArray(data[key]) || data[key].length > 1500 || !data[key].every(id)) throw Error('目标顺序格式无效');
      result[key] = [...new Set(data[key])];
    }
    if (!isMap(data.pains) || !isMap(data.goals)) throw Error('需求记录格式无效');
    for (const [key, item] of Object.entries(data.pains)) {
      if (!/^P\d{3,}$/.test(key) || !isMap(item) || !levels.includes(item.level) || typeof item.resolved !== 'boolean') throw Error('痛点设置无效');
      const byStandard = Object.create(null);
      if(item.byStandard!==undefined){
        if(!isMap(item.byStandard))throw Error('痛点标准格式无效');
        for(const [standard,level] of Object.entries(item.byStandard)){
          if((!standards.includes(standard)&&!/^自定义：.{1,100}$/.test(standard))||!levels.includes(level))throw Error('痛点标准等级无效');
          byStandard[standard]=level;
        }
      }
      result.pains[key] = {level: item.level, resolved: item.resolved, byStandard};

    }
    for (const [key, item] of Object.entries(data.goals)) {
      if (!id(key) || !isMap(item) || typeof item.resolved !== 'boolean' || (item.fulfilled !== null && !amount(item.fulfilled))) throw Error('目标设置无效');
      result.goals[key] = {fulfilled: item.fulfilled === null ? null : cents(item.fulfilled) / 100, resolved: item.resolved};
    }
    return result;
  }
  function calculate(settings, snapshot) {
    const assets = settings.assets === null ? null : cents(settings.assets);
    const debts = settings.debts === null ? null : cents(settings.debts);
    const available = settings.available === null ? null : cents(settings.available);
    const threshold = cents(settings.threshold);
    const canUpgrade = available !== null && available > threshold && settings.survival;
    const development = canUpgrade ? available - threshold : 0;
    const goalById = new Map(snapshot.goals.map(goal => [goal.id, goal]));
    const goalRows = new Map(snapshot.goals.map(goal => {
      const confirmed = settings.goals[goal.id];
      const budget = amount(goal.budget) ? cents(goal.budget) : null;
      const fulfilled = confirmed?.fulfilled == null ? null : cents(confirmed.fulfilled);
      const resolved = confirmed?.resolved === true;
      return [goal.id, {...goal, budget, fulfilled, resolved, cost: budget === null ? null : Math.max(0, budget - (fulfilled ?? 0)), allocated: 0, cumulative: null, status: ''}];
    }));
    const pains = snapshot.pains.map(pain => {
      const original = levelFor(settings,pain);
      return {...pain, original, dynamic: original, resolved: settings.pains[pain.id]?.resolved === true, links: [...new Set(pain.links || [])].filter(link => goalRows.has(link))};
    });
    function nearestGoalAncestor(goal) {
      const parent = goal.parent?.replace(/^CAT:/, '');
      return goalById.get(parent);
    }
    const linkedIds = new Set(pains.filter(pain => pain.original !== 'P2').flatMap(pain => pain.links));
    const descendants = new Map();
    for (const leaf of linkedIds) {
      const seen = new Set([leaf]);
      for (let node = nearestGoalAncestor(goalById.get(leaf)); node && !seen.has(node.id); node = nearestGoalAncestor(node)) {
        seen.add(node.id);
        if (!descendants.has(node.id)) descendants.set(node.id, []);
        descendants.get(node.id).push(leaf);
      }
    }
    for (const pain of pains) {
      if (pain.original === 'P2') continue;
      pain.links = [...new Set(pain.links.flatMap(link => descendants.get(link)?.filter(child => !descendants.has(child)) || [link]))];
    }
    const nativeIds = new Set(pains.filter(p => p.original === 'P0-A' && !p.resolved).flatMap(p => p.links));
    const candidateIds = new Set(pains.filter(p => p.original === 'P1' && !p.resolved).flatMap(p => p.links));
    const manualOrder = new Map(settings.order.map((key, index) => [key, index]));
    const candidates = [...candidateIds].map(key => goalRows.get(key)).filter(goal => !goal.resolved && !nativeIds.has(goal.id));
    candidates.sort((a,b) => {
      if (a.cost === null || b.cost === null) return Number(a.cost === null) - Number(b.cost === null) || a.id.localeCompare(b.id);
      if (settings.sortMode === 'manual') return (manualOrder.get(a.id) ?? Infinity) - (manualOrder.get(b.id) ?? Infinity) || a.id.localeCompare(b.id);
      return (settings.sortMode === 'amountDesc' ? b.cost-a.cost : a.cost-b.cost) || a.id.localeCompare(b.id);
    });
    let remaining = development;
    let cumulative = 0n;
    let blocked = !canUpgrade;
    const previous = new Set(settings.held);
    const held = new Set();
    for (const goal of candidates) {
      if (goal.cost === null) {
        goal.status = '待确认预算';
        continue;
      }
      cumulative += BigInt(goal.cost);
      goal.cumulative = sumResult(cumulative);
      if (!blocked && goal.cost <= remaining && (settings.autoUpgrade || previous.has(goal.id))) {
        held.add(goal.id);
        remaining -= goal.cost;
        goal.allocated = goal.cost;
        goal.status = '已配置';
      } else {
        blocked = true;
        if (!settings.autoDowngrade && previous.has(goal.id)) {
          held.add(goal.id);
          goal.status = '保留原等级，资金待配置';
        } else {
          goal.status = canUpgrade ? '暂未配置' : '未达到升级条件';
        }
      }
    }
    for (const pain of pains) {
      const linked = pain.links.map(key => goalRows.get(key));
      const outstanding = linked.filter(goal => !goal.resolved);
      const eligible = outstanding.filter(goal => !nativeIds.has(goal.id));
      if (pain.original === 'P1' && !pain.resolved && eligible.length && eligible.every(goal => held.has(goal.id))) pain.dynamic = 'P0-B';
      pain.reason = pain.resolved ? '已标记解决' : pain.original === 'P0-A' ? '原生刚需' : pain.original === 'P2' ? '不参与资金分配' :
        !linked.length ? '待关联目标' : outstanding.some(goal => goal.cost === null) ? '待确认预算' :
        !outstanding.length ? '关联目标已完成，待确认痛点解决状态' :
        pain.dynamic === 'P0-B' ? (eligible.every(goal => goal.status === '已配置') ? '按顺序已配置资金' : '保留原等级，资金待配置') :
        !canUpgrade ? '温饱目标或可支配净资产未达到升级条件' : '当前顺序下暂未配置全部资金';
    }
    return {
      net: assets === null || debts === null ? null : assets-debts,
      gap: available === null ? null : Math.max(0, threshold-available),
      rate: available === null || threshold === 0 ? null : available/threshold,
      nativeBudget: sumResult([...nativeIds].map(key=>goalRows.get(key)).reduce((total,goal)=>total+BigInt(goal.resolved?0:goal.cost??0),0n)),
      development, allocated: development-remaining, remaining, canUpgrade,
      held: [...held], candidates, goals: goalRows, pains,
      pending: sumResult(candidates.filter(goal => goal.cost !== null && goal.status !== '已配置').reduce((total,goal) => total+BigInt(goal.cost),0n))
    };
  }
  return {defaults, validate, calculate, standards, cents, standardKey, levelFor};
})();
if (typeof module !== 'undefined') module.exports = Needs;
