'use strict';
const fs=require('node:fs');
const path=require('node:path');
const REPORT_FONT_FILES=['NotoSansSC-VF.ttf','NotoSansSC-Numerals-Medium.ttf','NotoSansSC-Numerals-Bold.ttf'];
function validateReportFonts(directory=path.join(__dirname,'../assets/fonts')) {
  const invalid=[];
  for(const name of REPORT_FONT_FILES) {
    try {
      const bytes=fs.readFileSync(path.join(directory,name));
      const signature=bytes.subarray(0,4).toString('hex');
      if(bytes.length<1000 || !['00010000','4f54544f','74746366'].includes(signature))invalid.push(name);
    } catch {invalid.push(name);}
  }
  return {ok:invalid.length===0,invalid};
}
module.exports={validateReportFonts,REPORT_FONT_FILES};
