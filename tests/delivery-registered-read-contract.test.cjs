'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');
// Babel is already installed by the web build (Vue compiler); this test adds no
// runtime dependency or new page-script capability to the Windows collector.
const {parse}=createRequire(path.resolve(__dirname,'../frontend/package.json'))('@babel/parser');
const {RemoteLocator,readers,normalize}=require('../syncbot/windows-client/extension-broker.cjs');
const files=['operating-download.js','product-download.js','runner.js','settlement-all-runner.js','settlement-runner.js'];
function readCalls(source){
 const found=[],ast=parse(source,{sourceType:'unambiguous'});
 function visit(node){if(!node||typeof node!=='object')return;
  if(['CallExpression','OptionalCallExpression'].includes(node.type)&&['MemberExpression','OptionalMemberExpression'].includes(node.callee?.type)){
   const property=node.callee.property,method=node.callee.computed?property.value:property.name;
   if(['evaluate','evaluateAll'].includes(method)){
    const fn=node.arguments[0];assert(['ArrowFunctionExpression','FunctionExpression'].includes(fn?.type),'Extension reads must use a registered inline literal, line '+node.loc.start.line);
    found.push({method,source:source.slice(fn.start,fn.end),line:node.loc.start.line});
   }
  }
  for(const value of Object.values(node))if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value);
 }visit(ast);return found;
}
test('every evaluate call in shipped Meituan download runners resolves through the real extension whitelist',async()=>{
 let total=0;
 for(const file of files){
  const source=fs.readFileSync(path.resolve(__dirname,'../syncbot/src/meituan-delivery',file),'utf8'),calls=readCalls(source);
  assert(calls.length>0,file+' was not checked');
  for(const call of calls){
   const expected=readers.get(normalize(call.source));assert(expected,`${file}:${call.line} ${call.method}: extension_reader_not_registered`);
   let dispatched;const locator=new RemoteLocator({descriptor:{frameId:1},broker:{diagnostics:[],call:async(_d,command)=>{dispatched=command;return true;}}});
   // RemoteLocator only normalizes Function#toString; use the exact parsed source
   // without evaluating or executing it in the test process.
   await locator[call.method]({toString:()=>call.source});
   assert.equal(dispatched.reader,expected);assert.equal(dispatched.action,call.method==='evaluate'?'read':'readAll');total++;
  }
 }
 assert(total>=19,'The collector reader gate unexpectedly lost coverage');
});
test('reader gate rejects the unregistered field-name lambda that passed earlier mock-only tests',()=>{
 const [call]=readCalls("labels.evaluateAll(es=>es.map(e=>e.textContent.trim()));");
 assert.equal(readers.has(normalize(call.source)),false);
 const locator=new RemoteLocator({descriptor:{},broker:{call(){throw Error('must_not_dispatch');}}});
 assert.throws(()=>locator.evaluateAll({toString:()=>call.source}),/extension_reader_not_registered/);
 assert.throws(()=>readCalls('labels.evaluateAll(unreviewedReader);'),/registered inline literal/);
});
