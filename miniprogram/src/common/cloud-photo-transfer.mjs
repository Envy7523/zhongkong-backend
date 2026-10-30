// Keep each callContainer request small without reducing evidence photo quality.
export const UPLOAD_CHUNK_LENGTH = 48 * 1024
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024
async function retry(fn){for(let n=0;;n++){try{return await fn()}catch(e){if(n>=3||(e.status&&e.status<500)||/登录|权限|无效|不完整|失效|50MB|版本不匹配/.test(e.message||''))throw e;await new Promise(r=>setTimeout(r,500*2**n))}}}

// read(offset,length) returns only one base64 segment. No whole-file string on mobile.
export async function uploadTaskPhotoSource(call,id,source,onProgress=()=>{},prefix='/api/mp/store-tasks'){
  if(!Number.isInteger(source.size)||source.size<=0||source.size>MAX_IMAGE_BYTES||!['jpeg','png','webp'].includes(source.mime))throw new Error('单张照片最多50MB，支持JPEG、PNG、WebP')
  const base=`${prefix}/instances/${id}/photo`,length=Math.ceil(source.size/3)*4
  const {upload_id,chunk_length}=await call({url:base+'/start',method:'POST',data:{mime:source.mime,length},silent:true})
  if(!upload_id||chunk_length!==UPLOAD_CHUNK_LENGTH)throw new Error('图片上传服务版本不匹配，请联系管理员更新服务')
  const rawLength=chunk_length/4*3,count=Math.ceil(source.size/rawLength);let next=0,done=0,failed=false
  onProgress(0)
  async function worker(){while(next<count&&!failed){const index=next++;try{
    const chunk=await source.read(index*rawLength,Math.min(rawLength,source.size-index*rawLength))
    await retry(()=>call({url:base+'/chunk',method:'POST',data:{upload_id,index,chunk},silent:true}))
    onProgress(Math.min(99,Math.floor(++done/count*99)))
  }catch(e){failed=true;throw e}}}
  // Small concurrent requests improve large-photo latency without large bodies.
  const results=await Promise.allSettled(Array.from({length:Math.min(4,count)},worker))
  const failure=results.find(r=>r.status==='rejected');if(failure)throw failure.reason
  const result=await retry(()=>call({url:base,method:'POST',data:{upload_id},timeout:60000,silent:true}));onProgress(100);return result
}

export async function uploadTaskPhoto(call, id, data) {
  const match = String(data || '').match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/)
  if (!match) throw new Error('照片格式无效')
  const size=match[2].length/4*3-(match[2].endsWith('==')?2:match[2].endsWith('=')?1:0)
  return uploadTaskPhotoSource(call,id,{size,mime:match[1],read:async(offset,length)=>match[2].slice(offset/3*4,Math.ceil((offset+length)/3)*4)})
}

export async function readTaskPhoto(call, path, variant='original', sink, onProgress=()=>{},prefix='/api/mp/store-tasks') {
  const base = prefix+'/photo?path=' + encodeURIComponent(path)+'&variant='+variant
  const first = await call({ url: base + '&chunk=0' })
  if (!['jpeg', 'png', 'webp'].includes(first.mime) || !Number.isInteger(first.total) || first.total < 1 || first.total > 356 || first.index !== 0 || typeof first.chunk !== 'string') throw new Error('图片读取服务返回无效结果')
  const chunks = sink?[]:[first.chunk]
  if(sink)await sink(first,0)
  onProgress(Math.floor(100/first.total))
  const pending=new Map();let next=1
  const prefetch=()=>{while(next<first.total&&pending.size<4){const index=next++;pending.set(index,retry(()=>call({url:base+'&chunk='+index,silent:true})).then(value=>({value}),error=>({error})))}}
  prefetch()
  for (let index = 1; index < first.total; index++) {
    const item=await pending.get(index);pending.delete(index);if(item.error)throw item.error;const result=item.value
    if (result.total !== first.total || result.mime !== first.mime || result.index !== index || typeof result.chunk !== 'string') throw new Error('照片在读取期间发生变化，请重新打开')
    if(sink)await sink(result,index);else chunks.push(result.chunk)
    onProgress(Math.floor((index+1)/first.total*100))
    prefetch()
  }
  return sink?{mime:first.mime,bytes:first.bytes}:{ data: `data:image/${first.mime};base64,${chunks.join('')}` }
}

export function cloudErrorHint(err) {
  const raw = err?.errMsg || err?.message || '网络异常'
  if (Number(err?.errCode) === -606001 || /-606001/.test(raw)) return '图片或请求内容超过云通道大小限制（-606001），请使用支持分段传输的最新版本'
  if (Number(err?.errCode) === -606002 || /-606002/.test(raw)) return '返回内容超过云通道大小限制（-606002），请使用支持分段读取的最新版本'
  return `云通道请求失败：${raw}`
}

export function requestBodyBytes(data) {
  const text = JSON.stringify(data) || ''
  let bytes = 0
  for (const char of text) { const code = char.codePointAt(0); bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4 }
  return bytes
}
