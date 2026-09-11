/** 生成导入用测试工作簿（三页签与正式模板列名一致） */
const path = require('path');
const XLSX = require(path.join(__dirname, '..', 'node_modules', 'xlsx'));

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
  { '禽类(鹅/鸭/鸡)': '鸭', '品种名称': '验证用鸭-临时', '单只净重(kg)': 2.8, '单只成本(元)': 45, '状态': '启用', '备注': '导入验证' },
  { '禽类(鹅/鸭/鸡)': '猪', '品种名称': '应被跳过-临时', '单只净重(kg)': 0, '单只成本(元)': 0, '状态': '启用', '备注': '' },
]), '① 禽类档案');

XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
  { '品种名称': '验证用鸭-临时', '部位名称': '鸭腿', '一只出成数量': 2, '单份克重(g)': 120, '备注': '导入验证' },
  { '品种名称': '不存在的品种-临时', '部位名称': 'x', '一只出成数量': 1, '单份克重(g)': '', '备注': '应报错跳过' },
]), '② 整只出成');

XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
  { '菜品名称': '验证临时菜-导入', '规格': '标准', '分类': '', '品种名称': '验证用鸭-临时', '部位名称': '鸭腿', '每份耗用数量': 1 },
  { '菜品名称': '不存在的菜品-临时', '规格': '', '分类': '', '品种名称': '验证用鸭-临时', '部位名称': '鸭腿', '每份耗用数量': 1 },
  { '菜品名称': '验证临时菜-导入', '规格': '标准', '分类': '', '品种名称': '', '部位名称': '', '每份耗用数量': '' },
]), '③ 菜品耗用');

const out = path.join(__dirname, 'test-import.xlsx');
XLSX.writeFile(wb, out);
console.log('written: ' + out);
