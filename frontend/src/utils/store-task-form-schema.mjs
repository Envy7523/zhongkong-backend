// Only the supported task schema crosses the API boundary. Designer events,
// remote data sources, default answers and executable rules are never persisted.
const typeMap={text:'input',choice:'radio',multiple:'checkbox',dropdown:'select',number:'inputNumber',date:'datePicker',photo:'taskPhoto'}
const reverse=Object.fromEntries(Object.entries(typeMap).map(([k,v])=>[v,k]))
export const questionNumber=index=>String(index+1).padStart(2,'0')
export function toDesignerRule(q){
  const props={}
  if(q.type==='photo')Object.assign(props,{min:q.min,max:q.max})
  if(q.type==='text')Object.assign(props,{type:q.multiline===false?'text':'textarea',maxlength:q.maxLength||2000,placeholder:q.placeholder||'请输入',rows:3,showWordLimit:true,format:q.format||'plain'})
  if(q.type==='number')Object.assign(props,{min:q.lower??undefined,max:q.upper??undefined,precision:q.precision??2,placeholder:q.placeholder||'请输入数值',controls:false})
  if(q.type==='date')Object.assign(props,{type:'date',valueFormat:'YYYY-MM-DD',placeholder:'选择日期'})
  const validate=[]
  if(q.type==='photo')validate.push({type:'array',min:q.required?Math.max(q.min,1):q.min,max:q.max,message:`请上传${q.min}至${q.max}张图片`,trigger:'change'})
  if(q.type==='text'&&q.format==='phone')validate.push({pattern:/^\d{11}$/,message:'请输入11位手机号',trigger:'blur'})
  return {type:typeMap[q.type],_fc_drag_tag:q.designerTag||`task_${q.type}`,field:q.id,title:q.title,info:'',execution_mode:q.execution_mode||'shared',prefix:{type:'TaskInstructions',props:{text:q.description||'',images:q.guide_images||[]}},$required:q.required!==false,props,validate,options:q.options?.map(value=>({label:value,value}))}
}
export function fromDesignerRules(rules){
  if(!Array.isArray(rules)||rules.length<1||rules.length>60)throw new Error('请设置1至60个问题')
  const ids=new Set()
  return rules.map((r,i)=>{
    const type=reverse[r.type],p=r.props||{},guide=r.prefix?.type==='TaskInstructions'?r.prefix.props||{}:{},q={id:r.field,title:String(r.title||'').trim(),description:String(guide.text??r.info??'').trim(),type,required:!!r.$required}
    if(guide.images?.length){if(!Array.isArray(guide.images)||guide.images.length>3||guide.images.some(p=>typeof p!=='string'||!/^\/uploads\/store-tasks\/guides\/[\da-f-]{36}\.(jpg|png|webp)$/.test(p)))throw new Error('每题最多3张说明图片，请从上传入口添加');q.guide_images=[...guide.images]}
    if(!type)throw new Error(`第${questionNumber(i)}题类型尚未接入任务填写`)
    if(!['single','shared'].includes(r.execution_mode||'shared'))throw new Error('执行方式不正确');q.execution_mode=r.execution_mode||'shared';
    if(!q.title)throw new Error(`请填写第${questionNumber(i)}题的标题`)
    if(!/^[\w-]{1,80}$/.test(q.id||'')||ids.has(q.id))throw new Error('题目标识重复，请重新添加该题');ids.add(q.id)
    if(type==='photo'){q.min=Number(p.min??1);q.max=Number(p.max??1);if(!Number.isInteger(q.min)||!Number.isInteger(q.max)||q.min<0||q.max<Math.max(q.min,1)||q.max>9)throw new Error(`第${questionNumber(i)}题图片数量需在0至9张内，最多不能少于最少`)}
    if(['choice','multiple','dropdown'].includes(type)){q.options=(r.options||[]).map(o=>String(o.label??o.value??'').trim());if(q.options.length<2||q.options.length>12||q.options.some(v=>!v)||new Set(q.options).size!==q.options.length)throw new Error(`第${questionNumber(i)}题需设置2至12个不为空、不重复的选项`)}
    if(type==='text'){q.multiline=p.type==='textarea';q.maxLength=Number(p.maxlength||2000);q.placeholder=String(p.placeholder||'');q.format=p.format==='phone'?'phone':'plain'}
    if(type==='number'){if(p.min!=null)q.lower=Number(p.min);if(p.max!=null)q.upper=Number(p.max);q.precision=Number(p.precision??2);q.placeholder=String(p.placeholder||'');if(q.lower!=null&&q.upper!=null&&q.lower>q.upper)throw new Error(`第${questionNumber(i)}题的最小数值不能超过最大数值`)}
    return q
  })
}
