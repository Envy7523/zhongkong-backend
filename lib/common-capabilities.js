'use strict';
// Shared entry/action rights never replace per-record ownership or store scope.
const CODES=['notifications.view','collab.manage','collab.create','collab.edit','store-reports.submit'];
const isCommon=code=>CODES.includes(code);
function forUser(user,permissions=[]){
  // Existing import-only identities keep their exact service permissions.
  if(/importer|syncbot/i.test(user.username||'')||permissions.length&&permissions.every(p=>p.endsWith('.import')))return [];
  return CODES;
}
module.exports={CODES,isCommon,forUser};
