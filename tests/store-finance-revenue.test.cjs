const test=require('node:test'),assert=require('node:assert/strict');
const {calculate}=require('../lib/store-finance-revenue');
function source(){const date='2026-10-11';const bill=(bill_type,amount)=>({bill_date:date,bill_type,amount,match_status:'matched'});return{pos:[{biz_date:date,channel:'store_sales',recorded_amount:3449.71},{biz_date:date,channel:'pickup',recorded_amount:0},{biz_date:date,channel:'jd_delivery',recorded_amount:999}],composition:[{biz_date:date,category:'美团/大众点评团购',amount:690.2},{biz_date:date,category:'抖音团购',amount:229.6},{biz_date:date,category:'现金',amount:0},{biz_date:date,category:'扫码支付',amount:2529.91},{biz_date:date,category:'会员卡',amount:0}],platform:[{biz_date:date,channel:'meituan_group',actual_amount:646.74,service_fee:41.46,insurance_fee:2,promotion_fee:69.6},{biz_date:date,channel:'douyin_group',actual_amount:219.97,service_fee:9.4,insurance_fee:.23,promotion_fee:0}],external:[],bills:{meituan:[bill('外卖订单',497.47),bill('保险',-4.35),bill('推广账户充值',-50)],taobao:[bill('外卖',376.23),bill('余额变动',-100),bill('闪购联盟推广',-10.01),bill('保障服务费',-8.48),bill('爆单红包增量出资',-1.8)],jd:[bill('正向订单',31.4),bill('保险单 · 食安险',-.24),bill('保险单 · 用户取消险',-.3),bill('保险单 · 准时保+',-.38)]}};}
test('一键买单归美团团购：堂食扣除尾款、手续费不收团购，平台缺失不伪造收入',()=>{
 const s=source(),day='2026-10-11';s.pos=[{biz_date:day,channel:'store_sales',recorded_amount:200}];s.composition=[['美团/大众点评团购',50],['抖音团购',0],['一键买单（尾款）',38],['现金',20],['会员卡',12],['扫码支付',80]].map(([category,amount])=>({biz_date:day,category,amount}));s.platform=[];s.bills={meituan:[],taobao:[],jd:[]};
 const r=calculate(s,day,day);assert.equal(r.values.dine,112);assert.equal(r.details.find(x=>x.platform==='堂食/外带').amount,.3);assert.equal(r.values.meituanGroup,0);
});
test('堂食只取现金＋扫码＋会员卡，不由店内总额推导；推广费与手续费分开',()=>{
 const s=source(),day='2026-10-11';s.pos[0].recorded_amount=99999;s.composition.push({biz_date:day,category:'其他收入',amount:8888});
 const r=calculate(s,day,day);assert.equal(r.values.dine,2529.91);assert.equal(r.details.find(x=>x.platform==='堂食/外带').amount,9.61);
 assert.equal(r.values.promotion,-151.8);assert.ok(!r.details.filter(x=>x.category==='third_party').some(x=>x.label==='推广账户充值'||x.label==='余额变动'));
 s.composition=s.composition.filter(x=>x.category!=='会员卡');const missing=calculate(s,day,day);assert.equal(missing.values.dine,null);assert.equal(missing.ready,false);
});
test('保利上城真实样例：剔除收银团购、按0.38%手续费、平台加回及充值只计一次',()=>{const r=calculate(source(),'2026-10-11','2026-10-11');assert.equal(r.values.dine,2529.91);assert.equal(r.details.find(x=>x.platform==='堂食/外带').amount,9.61);assert.equal(r.values.meituan,497.47);assert.equal(r.values.taobao,476.23);assert.equal(r.values.jd,31.4);assert.equal(r.values.meituanGroup,759.8);assert.equal(r.values.douyinGroup,229.6);assert.equal(r.values.promotion,-151.8);assert.equal(r.ready,true);assert.equal(r.details.find(x=>x.label==='爆单红包增量出资').category,'promotion');assert.equal(r.values.fee,-156.06);});
test('缺失平台记为零，不允许POS外卖回填；额外推广与刷单分开',()=>{const s=source();s.bills.jd=[];s.external=[{platform:'淘宝闪购',expense_date:'2026-10-11',expense_type:'霸王餐',amount:20},{platform:'淘宝闪购',expense_date:'2026-10-11',expense_type:'第三方推广',amount:30}];const r=calculate(s,'2026-10-11','2026-10-11');assert.equal(r.values.jd,0);assert.equal(r.values.taobao,506.23);assert.equal(r.values.promotion,-181.8);assert.equal(r.values.fakeOrders,-20);});
test('已明确的费用反向冲销保留符号；无数据不制造扣费',()=>{const s=source();s.bills.meituan.push({bill_date:'2026-10-11',bill_type:'推广账户充值原路退回',amount:5});const r=calculate(s,'2026-10-11','2026-10-11');assert.equal(r.values.meituan,497.47);assert.equal(r.values.promotion,-146.8);});
test('美团流量助手及其退款均为第三方费用，退款冲减而非推广',()=>{const s=source();s.bills.meituan.push({bill_date:'2026-10-11',bill_type:'流量助手节省转入广告',amount:-20},{bill_date:'2026-10-11',bill_type:'流量助手节省转入广告退款',amount:5});const r=calculate(s,'2026-10-11','2026-10-11');assert.equal(r.values.promotion,-151.8);assert.equal(r.values.fee,-171.06);assert.equal(r.values.meituan,497.47);assert.ok(r.details.filter(x=>x.label.startsWith('流量助手')).every(x=>x.category==='third_party'));});
test('指定休息日缺少营业数据正常，其他日期仍报告缺失',()=>{const s={pos:[],composition:[],platform:[],external:[],bills:{meituan:[],taobao:[],jd:[]},closed_dates:['2026-09-02']};const rest=calculate(s,'2026-09-02','2026-09-02');assert.equal(rest.values.dine,0);assert.equal(rest.ready,true);assert.deepEqual(rest.problems,[]);assert.equal(calculate(s,'2026-09-03','2026-09-03').ready,false);});
test('休息日如出现真实收银金额必须提示冲突，不能覆盖成零',()=>{const s=source();s.closed_dates=['2026-10-11'];const r=calculate(s,'2026-10-11','2026-10-11');assert.equal(r.ready,false);assert.ok(r.problems.some(x=>x.includes('已登记休息')));});
test('三平台资金结构明确相加，余额充值仅计推广，费用扣减各一次',()=>{
 const r=calculate(source(),'2026-10-11','2026-10-11');
 assert.deepEqual(['actual','third_party','promotion','income'].map(k=>r.delivery.taobao[k]),[355.94,18.49,101.8,476.23]);
 for(const [key,s]of Object.entries(r.delivery)){assert.equal(Math.round((s.actual+s.third_party+s.promotion)*100)/100,r.values[key]);for(const [field,rows]of [['actual','actual_rows'],['third_party','third_party_rows'],['promotion','promotion_rows']])assert.equal(Math.round(s[rows].reduce((n,r)=>n+r.amount,0)*100)/100,s[field]);}
});
test('布吉9月24至28账单：订单退款只冲减实收，流量助手退款冲减第三方',()=>{
 const s=source();s.bills.meituan=[];
 for(const [date,income,insurance]of [['2026-09-24',716.03,8.68],['2026-09-25',731.82,5.65],['2026-09-26',843.75,9.3],['2026-09-27',912.59,8.68],['2026-09-28',790.03,7.75]])s.bills.meituan.push({bill_date:date,bill_type:'外卖订单',amount:income},{bill_date:date,bill_type:'保险',amount:-insurance});
 for(const [date,type,amount]of [['2026-09-26','订单退款',-15.68],['2026-09-26','流量助手节省转入广告',-.61],['2026-09-26','流量助手节省转入广告退款',.61],['2026-09-27','流量助手节省转入广告',-3.72],['2026-09-28','流量助手节省转入广告',-.61]])s.bills.meituan.push({bill_date:date,bill_type:type,amount});
 const r=calculate(s,'2026-09-01','2026-09-28');assert.deepEqual(['actual','third_party','promotion','income'].map(k=>r.delivery.meituan[k]),[3934.15,44.39,0,3978.54]);assert.ok(!r.delivery.meituan.third_party_rows.some(r=>r.label==='订单退款'));
});
test('未确认的费用不强行归为第三方或推广，收入留空供核对',()=>{const s=source();s.bills.meituan.push({bill_date:'2026-10-11',bill_type:'未确认服务项目',amount:-3});const r=calculate(s,'2026-10-11','2026-10-11');assert.equal(r.values.meituan,null);assert.equal(r.delivery.meituan.income,null);assert.equal(r.ready,false);});

