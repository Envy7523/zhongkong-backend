import { localDate } from './format'
export const activeStore = () => uni.getStorageSync('mp_active_store') || null
export const selectStore = store => uni.setStorageSync('mp_active_store', store)
export const taskStatus = status => ({draft:'待完成',pending:'待审核',approved:'已通过',rejected:'已退回'}[status] || status)
export function taskRange(mode) {
  const start = new Date(), end = new Date()
  if(mode === 'week'){ start.setDate(start.getDate() - ((start.getDay()+6)%7)); end.setDate(start.getDate()+6) }
  if(mode === 'month'){ start.setDate(1); end.setMonth(end.getMonth()+1,0) }
  return {from:localDate(start),to:localDate(end)}
}
export function imageData(filePath) {
  // #ifdef MP-WEIXIN
  return new Promise((resolve,reject)=>uni.getFileSystemManager().readFile({filePath,encoding:'base64',success:r=>resolve('data:image/jpeg;base64,'+r.data),fail:reject}))
  // #endif
  // #ifndef MP-WEIXIN
  return fetch(filePath).then(r=>r.blob()).then(blob=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(blob)}))
  // #endif
}
