'use strict';
const {createCanvas}=require('@napi-rs/canvas');
const {reportFontsReady}=require('./pos-daily-image'); // Registers the bundled Chinese and numeric fonts.
function render(data) {
  if(!reportFontsReady().ok) throw new Error('日报字体不可用');
  const widths=[170,440,210,210,210,260], W=1500, top=66, gap=18, head=116, rowH=46;
  const member=data.member_card_consumption;
  const canvas=createCanvas(W,top+gap+head+data.rows.length*rowH+2+(member?126:0)),ctx=canvas.getContext('2d');
  ctx.fillStyle='#fff';ctx.fillRect(0,0,W,canvas.height);
  function cell(text,x,y,w,h,bg='#fff',opts={}) {
    ctx.fillStyle=bg;ctx.fillRect(x,y,w,h);ctx.strokeStyle='#333';ctx.lineWidth=1;ctx.strokeRect(x+.5,y+.5,w,h);
    ctx.save();ctx.beginPath();ctx.rect(x+4,y+2,w-8,h-4);ctx.clip();ctx.fillStyle=opts.color||'#111';ctx.textBaseline='middle';
    let size=opts.size||25;const family=opts.numeric?'"Daily Numerals Medium", "Noto Sans SC"':'"Noto Sans SC"';
    ctx.font=`600 ${size}px ${family}`;while(ctx.measureText(text).width>w-20&&size>14)ctx.font=`600 ${--size}px ${family}`;
    ctx.textAlign=opts.right?'right':'center';ctx.fillText(text,opts.right?x+w-12:x+w/2,y+h/2);ctx.restore();
  }
  const orange='#f4b183', blue='#305496', gray='#d9d9d9';
  cell('门店',0,0,170,top,orange,{color:'#fff'});cell(data.store_name,170,0,440,top,orange,{color:'#fff'});
  cell('填报日期',610,0,210,top,orange,{color:'#fff'});cell(data.business_date.replaceAll('-','/'),820,0,210,top,orange,{color:'#fff',numeric:true});cell(data.test_notice?'测试日报 · 数据待核对':'',1030,0,470,top,orange,{color:'#b42318',size:27});
  let x=0,y=top+gap;
  for(let i=0;i<6;i++) {
    const titles=['大类','项目明细','当日','本月累计','昨日','上月(取财务利润表)'];
    if(i<2)cell(titles[i],x,y,widths[i],head,blue,{color:'#fff'});
    else {cell(titles[i],x,y,widths[i],58,blue,{color:'#fff',size:24});cell([data.business_date.replaceAll('-','/'), data.month.replace('-','年')+'月',data.yesterday.replaceAll('-','/'),data.last_month.replace('-','年')+'月'][i-2],x,y+58,widths[i],58,blue,{color:'#fff',numeric:true,size:24});}
    x+=widths[i];
  }
  y+=head;
  for(let i=0;i<data.rows.length;i++) {
    const row=data.rows[i],bg=row.subtotal?gray:'#fff';x=170;
    cell(row.label+(row.reference?`（${row.reference}）`:''),x,y,440,rowH,bg,{size:24});
    // Red reference values are drawn inside the existing label cell, never in an extra column.
    if(row.reference) {
      const text=row.label+`（${row.reference}）`;let size=24;ctx.font=`600 ${size}px "Noto Sans SC"`;while(ctx.measureText(text).width>420&&size>14)ctx.font=`600 ${--size}px "Noto Sans SC"`;
      const total=ctx.measureText(text).width, prefix=ctx.measureText(row.label).width;
      ctx.textBaseline='middle';ctx.textAlign='left';ctx.fillStyle='#f00';ctx.fillText(`（${row.reference}）`,170+(440-total)/2+prefix,y+rowH/2);
    }
    x+=440;
    for(let j=0;j<4;j++) {const value=row.values[j];cell(value===null?'':row.rate?`${(value*100).toFixed(2)}%`:Number(value).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2}),x,y,widths[j+2],rowH,bg,{numeric:true,right:true,size:25});x+=widths[j+2];}
    if(i===0||data.rows[i-1].group!==row.group) {let count=1;while(data.rows[i+count]?.group===row.group)count++;cell(row.group,0,y,170,rowH*count,'#fff',{size:27});}
    y+=rowH;
  }
  if(member){
    const money=v=>Number(v||0).toFixed(2),ratio=v=>v==null?'—':(v*100).toFixed(2)+'%';
    const line=(m,title)=>m.ready?`${title}会员消费 ${money(m.consumption)}：本金 ${money(m.principal)}（${ratio(m.principal_ratio)}）　赠金 ${money(m.gift)}（${ratio(m.gift_ratio)}）　本金手续费测算 ${money(m.fee)}`:`${title}会员消费资料待核对，完整消费额、赠金及本金手续费暂留空`;
    cell(line(member.daily,'当日'),0,y,W,42,'#f1f6fc',{size:23});
    cell(line(member,'本月累计'),0,y+42,W,42,'#f1f6fc',{size:23});
    cell((member.ready?'':'会员数据待核对；')+'会员消费含赠金；赠金单列扣减，本金手续费已并入手续费合计，仅扣一次。本金手续费按0.38%逐笔测算，非实际提现账单。',0,y+84,W,42,'#fff',{size:21,color:member.ready?'#64748b':'#c45656'});
  }
  const buffer=canvas.toBuffer('image/png');return {buffer,base64:buffer.toString('base64'),layout:{width:W,height:canvas.height,body_y:top+gap+head,row_height:rowH,column_widths:widths}};
}
module.exports={render};
