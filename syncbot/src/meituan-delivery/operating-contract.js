'use strict';
// 第一个表的字段来自用户于 2026-10-06 提供的导出设置截图。
const identityFields = Object.freeze(['日期', '门店名称', '门店id', '省份', '门店所在城市', '区县市']);
const metrics = Object.freeze(['营业收入', '优惠前总额', '有效订单', '曝光人数', '入店人数',
  '入店转化率', '下单转化率', '下单人数', '综合体验分']);
module.exports = Object.freeze({
  platform: 'meituan_delivery', reportType: 'meituan_delivery_operating',
  origin: 'https://waimaie.meituan.com',
  navigation: Object.freeze(['经营罗盘', '报表下载']),
  identityFields, metrics, fields: Object.freeze([...identityFields, ...metrics]),
  downloadLabel: '下载数据',
});
