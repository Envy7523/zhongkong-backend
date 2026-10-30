'use strict';
const messages = require('./store-messages');
const context = require('./employee-mini-context');
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };

// Notifications use the existing active mini-program account audience.
function people(db) {
  return messages.users(db).map(user => ({
    id: user.id,
    name: user.display_name || user.username,
    position: user.position_name || user.role || '',
  }));
}
function ids(db, value) {
  if (!Array.isArray(value) || value.length > 30) fail('抄送人员最多30人');
  const result = [...new Set(value.map(Number))];
  const valid = new Set(people(db).map(person => person.id));
  if (result.some(id => !Number.isInteger(id) || !valid.has(id))) {
    fail('抄送账号已停用或未开放小程序，请重新选择');
  }
  return result;
}
function copied(db, report, user, channel) {
  const data = report.data || JSON.parse(report.data_json);
  if (!user || report.status === 'draft' || !(data.cc_user_ids || []).includes(user.id)) return false;
  context.assertAccount(db, user);
  return !user.access_configured || user.access_channels?.includes(channel);
}
function photos(db, report, value, user) {
  if (!Array.isArray(value) || value.length > 9 || new Set(value).size !== value.length) {
    fail('报告图片最多9张，不能重复');
  }
  const previous = report.data.report_photos || [];
  for (const reference of value) {
    const file = db.queryOne('SELECT * FROM inspection_files WHERE path=? AND report_id=?', [reference, report.id]);
    if (!file || (file.user_id !== user.id && !previous.includes(reference))) {
      fail('报告图片不属于当前报告及上传人');
    }
  }
  return value;
}
module.exports = { people, ids, copied, photos };
