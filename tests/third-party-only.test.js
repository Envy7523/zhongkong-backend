const test=require('node:test'),assert=require('node:assert/strict');
const analytics=require('../lib/business-analytics');
const channels={meituan_delivery:'delivery',taobao_flash:'delivery',jd_delivery:'delivery',meituan_group:'group_buy',douyin_group:'group_buy'};
function db(rows){return{queryOne:()=>({total:1}),queryAll:sql=>sql.includes('SELECT r.* FROM business_revenue_records')?structuredClone(rows):[],run:()=>{throw Error('must not write')}}}
function row(channel,source,extra={}){return{store_id:9,store_name:'方洲店',biz_date:'2026-10-07',channel,channel_group:channels[channel],source_type:source,recorded_amount:365.1,gross_amount:365.1,actual_amount:365.1,order_count:12,...extra}}
for(const [channel,group] of Object.entries(channels)){
 test(channel+' POS-only must be zero despite source override/cashier flag',()=>{let r=analytics.getResolvedRevenueByDate(db([row(channel,'pos')]),{channel_group:group,data_view:'cashier',source_overrides:JSON.stringify({[channel]:'pos'})});for(const key of ['gross','income','settled','confirmed','orders','resolved_fees'])assert.equal(r.rows[0][key],0,key);assert.equal(r.rows[0].source_status,'platform_missing_zero');assert.equal(r.missing_platform_days.length,1);});
 test(channel+' imports replace POS and zero platform orders stay zero',()=>{let r=analytics.getResolvedRevenueByDate(db([row(channel,'pos'),row(channel,'platform',{actual_amount:123,gross_amount:150,platform_income_amount:130,order_count:0})]),{channel_group:group});assert.equal(r.rows[0].confirmed,123);assert.equal(r.rows[0].gross,150);assert.equal(r.rows[0].orders,0);});
 test(channel+' partial days cannot fill missing dates from POS',()=>{let rows=[row(channel,'pos'),row(channel,'pos',{biz_date:'2026-10-06'}),row(channel,'platform',{actual_amount:100})];let r=analytics.getResolvedRevenueByDate(db(rows),{channel_group:group});assert.equal(r.rows.reduce((n,r)=>n+r.confirmed,0),100);});
}
test('separate total cashier view remains unchanged',()=>{let r=analytics.getResolvedRevenueByDate(db([row('meituan_delivery','pos')]),{data_view:'cashier'});assert.equal(r.rows[0].confirmed,365.1);});
