'use strict';
// Match the existing employee mobile format. Empty accounts may be completed later.
function mobile(value) {
  const phone=String(value??'').trim();
  if(phone&&!/^1[3-9]\d{9}$/.test(phone))throw Object.assign(new Error('请输入有效的11位中国大陆手机号，不支持微信号或QQ号'),{status:400});
  return phone;
}
module.exports={mobile};
