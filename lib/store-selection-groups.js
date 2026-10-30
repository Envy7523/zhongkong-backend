'use strict';
const closed=s=>['已闭店','闭店','迁址'].includes(String(s.status||'').trim());
function decorate(db,rows){
 let canonical=[];try{canonical=db.queryAll('SELECT id,status,province,city FROM stores')}catch{}
 const states=new Map(canonical.map(s=>[Number(s.id),s]));rows=rows.map(row=>({...row,...states.get(Number(row.id))}));
 let regions=[],members=[];try{regions=db.queryAll('SELECT id,name,parent_id,code FROM store_regions');members=db.queryAll('SELECT region_id,store_id FROM store_region_members')}catch{}
 const byId=new Map(regions.map(r=>[Number(r.id),r]));
 const label=id=>{const names=[],seen=new Set();let row=byId.get(Number(id));while(row&&!seen.has(row.id)){seen.add(row.id);names.unshift(row.name);row=byId.get(Number(row.parent_id))}return names.join(' / ')};
 return rows.map(s=>{const region=members.find(m=>Number(m.store_id)===Number(s.id)&&byId.has(Number(m.region_id))&&byId.get(Number(m.region_id)).code!=='closed');return {...s,selection_group:closed(s)?'closed':'region-'+(region?.region_id||[s.province,s.city].filter(Boolean).join('-')||'unassigned'),selection_group_name:closed(s)?'闭店门店':region?label(region.region_id):[s.province,s.city].filter(Boolean).join(' / ')||'未分区门店'}})
}
function decoratePayload(db,payload){if(!payload||typeof payload!=='object'||Array.isArray(payload))return payload;for(const [key,value] of Object.entries(payload)){if(['stores','destinations'].includes(key)&&Array.isArray(value)&&value.some(s=>s&&typeof s==='object'&&s.store_name))payload[key]=decorate(db,value);else if(value&&typeof value==='object'&&!Array.isArray(value))decoratePayload(db,value)}return payload}
module.exports={closed,decorate,decoratePayload};
