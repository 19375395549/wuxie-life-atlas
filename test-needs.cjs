const assert = require('node:assert/strict');
const { calculate, defaults, validate } = require('./site/needs.js');

const budgets = [50000, 100000, 150000, 200000, 300000, 500000, 1000000];
const goals = budgets.map((budget, index) => ({ id: 'G001-0' + (index + 1), budget }));
const pains = goals.map((goal, index) => ({ id: 'P00' + (index + 1), tier: 'L1', links: [goal.id] }));
const snapshot = { goals, pains };
const settings = { ...defaults(), available: 1500000, survival: true };
const run = (overrides = {}, data = snapshot) => calculate({ ...settings, ...overrides }, data);

for (const available of [500000, 1000000]) {
  assert.equal(run({ available }).held.length, 0);
}
assert.equal(run({ survival: false }).development, 0);
assert.equal(run().allocated, 50000000);
assert.equal(run().held.length, 4);
assert.equal(run({ available: 2000000 }).development, 100000000);
assert.equal(run({ available: 1200000 }).held.length, 2);
assert.equal(run({ threshold: 2000000 }).held.length, 0);
assert.equal(run({ threshold: 0 }).rate, null);
assert.equal(run({ sortMode: 'manual', order: ['G001-06'] }).held.length, 1);
assert.equal(run({ sortMode: 'manual', order: ['G001-07','G001-01'] }).held.length, 0);
assert.equal(run({ autoUpgrade: false }).held.length, 0);
const frozen = run({ available: 1200000, autoDowngrade: false, held: run().held });
assert.equal(frozen.held.length, 4);
assert.equal(frozen.remaining, 5000000);
assert.equal(run({}, { goals, pains: [...pains, { id: 'P008', tier: 'L1', links: [goals[0].id] }] }).candidates.length, 7);

const parent = { id: 'G001-08', budget: 500000 };
const child = { ...goals[0], parent: parent.id };
const hierarchy = { goals: [parent, child], pains: [{ ...pains[0], links: [parent.id, child.id] }] };
assert.equal(run({}, hierarchy).allocated, 5000000);
assert.equal(run({}, { goals: [{ ...goals[0], budget: null }], pains: [pains[0]] }).candidates[0].status, '待确认预算');
assert.equal(run({ pains: { P001: { level: 'P2', resolved: false } } }).candidates.length, 6);
assert.equal(run({ pains: { P001: { level: 'P1', resolved: true } }, available: 1200000 }).pains[0].resolved, true);
assert.equal(run({ goals: { 'G001-01': { fulfilled: 20000, resolved: false } } }).candidates[0].cost, 3000000);
assert.equal(run({ standard: '职业发展', pains: { P001: { level: 'P1', resolved: false, byStandard: { 职业发展: 'P0-A' } } } }).pains[0].dynamic, 'P0-A');
assert.throws(() => validate({ ...settings, assets: -1 }));
assert.throws(() => validate({ ...settings, threshold: null }));
assert.throws(() => validate({ ...settings, assets: NaN }));
assert.deepEqual(validate(JSON.parse(JSON.stringify(settings))), settings);
console.log('V3.0 资产分配、去重、评级、精度和备份格式测试通过');
