'use strict';
const food = require('./menu-shared-ingredients'), packs = require('./menu-packaging-schemes');
const fail = (message,status=400) => { throw Object.assign(new Error(message),{status}); };
function draftFor(db,item,data,cost) {
  const ownedId = db.queryOne('SELECT recipe_id FROM menu_dish_costs WHERE menu_item_id=?',[item.id])?.recipe_id;
  if (ownedId) return {...data.recipes.find(r=>r.id===ownedId),owned:true};
  // An imported workbook supplies initial values. Saving creates a dish-owned
  // record, so editing one SKU never rewrites a different SKU's quantities.
  const matching = cost.menuRecipe(db,item.id,data);
  const source = matching.linked_recipe || (matching.candidates.length===1?matching.candidates[0]:null);
  const mapping = packs.match(item,data.packaging_import?.mappings || []);
  const initial = source || {lines:[],packaging:[],packaging_status:'pending',source:'',source_total:null};
  return {...initial,id:'dish-'+item.id,name:item.name,category:item.category,variant:item.spec,revision:0,menu_item_id:item.id,menu_item_ids:[],source_recipe_id:source?.id || null,source_revision:source?.revision || null,cost_mode:source?.cost_mode || (initial.lines.length?'recipe':'manual'),manual_food_cost:source?.manual_food_cost ?? null,packaging_scheme_id:mapping?.scheme_id || initial.packaging_scheme_id || null,packaging_status:mapping?'configured':initial.packaging_status,owned:false,source_choices:matching.candidates.length>1?matching.candidates.map(r=>({id:r.id,name:r.name,variant:r.variant,lines:r.lines,source:r.source})):[]};
}
function build(db,item,data,cost) {
  const draft=cost.resolveRecipe(db,draftFor(db,item,data,cost));
  const plain=cost.calculateOrder([draft],data.packaging_materials,{items:[{recipe_id:draft.id,quantity:1}]});
  const packed=cost.calculateOrder([draft],data.packaging_materials,{channel:'delivery',items:[{recipe_id:draft.id,quantity:1}]});
  return {...draft,food_cost:plain.complete?plain.food_cost:null,base_cost:plain.total_cost,packed_cost:packed.total_cost,packing_cost:packed.packaging_cost,packing_complete:!packed.missing.some(m=>/包材|打包/.test(m.reason))};
}
function get(db,id,cost) {
  const data=cost.list(db),item=data.menu_items.find(m=>m.id===id);
  if(!item)fail('菜品不存在',404);
  if(item.item_type==='combo')fail('套餐请在原有套餐编辑中维护组成菜品');
  return {item,draft:build(db,item,data,cost),ingredients:data.ingredients,packaging_materials:data.packaging_materials,packaging_schemes:data.packaging_schemes};
}
function list(db,cost) {
  const data=cost.list(db);
  const dishes=data.menu_items.filter(m=>m.item_type!=='combo').map(item=>{
    const d=build(db,item,data,cost),s=data.packaging_schemes.find(s=>s.id===d.packaging_scheme_id);
    return {...item,food_cost:d.food_cost,base_cost:d.base_cost,packed_cost:d.packed_cost,packing_cost:d.packing_cost,packaging_scheme_id:d.packaging_scheme_id,scheme_name:s?.name||'',cost_mode:d.cost_mode,owned:d.owned,has_details:d.lines.length>0,source_choices:d.source_choices?.length||0,revision:d.revision,packaging_status:d.packaging_status};
  });
  dishes.sort((a,b)=>Number(b.base_cost!=null)-Number(a.base_cost!=null)||a.name.localeCompare(b.name,'zh-CN')||String(a.spec||'').localeCompare(String(b.spec||''),'zh-CN'));
  return {dishes,ingredients:data.ingredients,packaging_materials:data.packaging_materials,packaging_schemes:data.packaging_schemes,packaging_mappings:(data.packaging_import?.mappings||[]).map(m=>({...m,matched_menu_items:data.menu_items.filter(item=>packs.match(item,data.packaging_import.mappings)?.code===m.code).map(item=>({id:item.id,name:item.name,spec:item.spec}))})),packaging_import:data.packaging_import?{filename:data.packaging_import.filename,materials:data.packaging_import.materials.length,schemes:data.packaging_import.schemes.length,mappings:data.packaging_import.mappings.length,checks:data.packaging_import.checks.length}:null};
}
function save(db,id,body,cost) {
  const {draft:current}=get(db,id,cost);
  if(Number(body.revision)!==current.revision)fail('菜品成本已更新，请刷新后修改',409);
  if(!current.owned && (body.source_recipe_id||null)!==(current.source_recipe_id||null))fail('来源成本已变化，请刷新后修改',409);
  if(!current.owned && (body.source_revision||null)!==(current.source_revision||null))fail('来源成本已更新，请刷新后修改',409);
  const next=cost.saveRecipe(db,current.id,{...body,menu_item_ids:[]},{create:current.owned?null:current,menuItemId:id});
  return {draft:{...next,owned:true}};
}
function quote(db,id,body,cost) {
  const content=get(db,id,cost),current=content.draft;
  const next=cost.prepareRecipe(db,current,{...body.draft,menu_item_ids:[]});
  next.lines=food.hydrate(next.lines,content.ingredients);
  const resolved=cost.resolveRecipe(db,next);
  return {quote:cost.calculateOrder([resolved],content.packaging_materials,{channel:body.channel,packed:body.packed,items:[{recipe_id:resolved.id,quantity:body.quantity}]})};
}
module.exports={get,list,save,quote};
