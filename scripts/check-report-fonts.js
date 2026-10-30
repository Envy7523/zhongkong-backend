'use strict';
const {validateReportFonts}=require('../lib/report-fonts');
const result=validateReportFonts(process.argv[2]);
if(!result.ok){console.error('日报字体缺失或不是完整字体（包含Git LFS指针）：'+result.invalid.join('、'));process.exitCode=1;}
else {
  const registered=process.argv[2] ? result : require('../lib/pos-daily-image').reportFontsReady();
  if(!registered.ok){console.error('日报字体注册失败：'+registered.invalid.join('、'));process.exitCode=1;}
  else console.log('日报3个完整字体文件及注册检查通过');
}
