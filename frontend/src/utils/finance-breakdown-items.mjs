export function filterFinanceItems(items=[]){
 return items.flatMap(item=>{
  const children=filterFinanceItems(item.children||[]);
  const zero=item.amount!==null&&item.amount!==undefined&&Number.isFinite(Number(item.amount))&&Math.round(Number(item.amount)*100)===0;
  if(zero)return children.map(child=>({...child,label:item.label+' · '+child.label}));
  return [{...item,...(item.children?{children}:{})}];
 });
}
