'use strict';
const normalize=name=>String(name||'').replace(/[\s（）()]/g,'');
function names(db,platform){
  if(!db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='config'"))return [];
  const row=db.queryOne('SELECT value FROM config WHERE key=?',['platform_source_exclusions:'+platform]);
  if(!row)return [];
  const value=JSON.parse(row.value);if(!Array.isArray(value)||value.some(x=>typeof x!=='string'))throw Error('平台来源排除配置无效');return value;
}
function load(db,platform){const set=new Set(names(db,platform).map(normalize));return name=>set.has(normalize(name));}
function add(db,platform,values){
  if(!Array.isArray(values)||values.length>100||values.some(x=>typeof x!=='string'||!x.trim()||x.length>120))throw Error('排除来源门店名称无效');
  const all=[...new Set([...names(db,platform),...values.map(x=>x.trim())])];
  db.run('INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',['platform_source_exclusions:'+platform,JSON.stringify(all)]);
}
module.exports={load,add};
