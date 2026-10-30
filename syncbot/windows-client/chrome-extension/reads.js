/* Fixed, reviewed DOM readers. No eval, script text or page credentials cross the bridge. */
(function(root){
 const reads={
  values:elements=>elements.map(el=>el.value),
  primary:el=>el.classList.contains('roo-btn-primary'),
  primaryElement:el=>el.classList.contains('roo-btn-primary'),
  active:el=>[...el.classList].some(name=>name.startsWith('active_')),
  activeProduct:el=>[...el.classList].some(c=>c.startsWith('active_')),
  checked:el=>!!el.querySelector('input')?.checked,
  inventory:elements=>elements.map(el=>({name:el.textContent.trim(),checked:!!el.querySelector('input')?.checked,disabled:!!el.querySelector('input')?.disabled,key:el.querySelector('input')?.value||'',group:!el.querySelector('input')?.value&&!el.querySelector('input')?.disabled,})),
  selected:elements=>elements.filter(el=>{const input=el.querySelector('input');return input?.checked&&(input.value||input.disabled);}).map(el=>el.textContent.trim()),
  productInventory:es=>es.map(e=>({name:e.textContent.trim(),value:e.querySelector('input')?.value,disabled:e.querySelector('input')?.disabled})),
  productActual:es=>es.filter(e=>{const i=e.querySelector('input');return i?.checked&&i.value;}).map(e=>e.textContent.trim()),
  productSelected:es=>es.filter(e=>{const i=e.querySelector('input');return i?.checked&&(i.value||i.disabled);}).map(e=>e.textContent.trim()),
  settlementRows:es=>es.map(e=>{const c=e.querySelectorAll('td');return {id:c[0]?.textContent.trim(),content:c[1]?.textContent.trim(),operation:c[3]?.textContent.trim()};}).filter(r=>/^\d+$/.test(r.id)),
  disabled:e=>e.classList.contains('disabled'),
  operatingRows:(elements,prefix)=>elements.map(el=>{const cells=el.querySelectorAll('td');return {name:cells[0]?.textContent.trim()||'',time:cells[1]?.textContent.trim()||'',operation:cells[2]?.textContent.trim()||''};}).filter(row=>row.name.startsWith(prefix+'_')),
 };
 if(typeof module==='object')module.exports=reads;else root.ETG_READS=reads;
})(globalThis);
