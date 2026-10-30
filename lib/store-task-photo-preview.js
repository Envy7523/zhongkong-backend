'use strict';
const fs=require('fs'),path=require('path'),sharp=require('sharp');
sharp.cache({memory:24,files:10,items:30});sharp.concurrency(1);
// One decoder at a time, even when several stores upload concurrently.
let queue=Promise.resolve();const inflight=new Map();
function preview(file){
  const output=path.join(path.dirname(file),'.previews',path.basename(file)+'.jpg');
  if(fs.existsSync(output))return Promise.resolve(output);
  if(inflight.has(file))return inflight.get(file);
  const work=queue.then(async()=>{
    fs.mkdirSync(path.dirname(output),{recursive:true});
    const temp=output+'.tmp';
    try{await sharp(file,{limitInputPixels:100000000,sequentialRead:true}).rotate().resize(640,640,{fit:'inside',withoutEnlargement:true}).flatten({background:'#fff'}).jpeg({quality:75}).toFile(temp);fs.renameSync(temp,output);return output}
    catch(e){if(fs.existsSync(temp))fs.unlinkSync(temp);throw Object.assign(new Error('照片预览生成失败，请上传有效照片（最高1亿像素）'),{status:400})}
  });
  queue=work.catch(()=>{});inflight.set(file,work);work.finally(()=>inflight.delete(file)).catch(()=>{});return work;
}
module.exports={preview};
