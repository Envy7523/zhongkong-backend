export function validQueryRange(range) {
  return Array.isArray(range) && range.length === 2 && range.every(value => /^\d{4}-\d{2}-\d{2}$/.test(value || '')) && range[0] <= range[1];
}
export function validReviewScope(scope = {}) {
  const ids=String(scope.store_ids || scope.store_id || '').split(',').filter(Boolean);
  return ids.length>0 && ids.every(id=>/^\d+$/.test(id) && Number(id)>0) && validQueryRange([scope.date_from,scope.date_to]);
}
export function querySignature({platform,storeIds,range,previousRange,compare,timeMode,dataView}) {
  return JSON.stringify({platform,storeIds:[...storeIds].map(Number).sort((a,b)=>a-b),range,previousRange:compare?previousRange:[],compare,timeMode,dataView});
}
