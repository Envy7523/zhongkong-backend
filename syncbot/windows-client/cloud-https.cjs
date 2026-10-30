'use strict';
const https=require('node:https');
// Trust this provisioned IP certificate only for this client connection.
// Node still checks expiry and the requested IP's subjectAltName. No global TLS overrides.
function certifiedFetch(ca,{localAddress}={}){
 if(localAddress&&require("net").isIP(localAddress)!==4)throw Error("client_cloud_local_address_invalid");
 if(typeof ca!=='string'||!ca.includes('-----BEGIN CERTIFICATE-----')||ca.length>20000)throw Error('client_cloud_certificate_invalid');
 return async function(url,options={}){
  const target=new URL(url);if(target.protocol!=='https:')throw Error('client_cloud_https_required');
  return new Promise((resolve,reject)=>{
   const request=https.request(target,{method:options.method||'GET',headers:options.headers,ca,...(localAddress?{localAddress}:{}),signal:options.signal,rejectUnauthorized:true},response=>{
    const chunks=[];let size=0;
    response.on('data',chunk=>{size+=chunk.length;if(size>4*1024*1024){request.destroy(Error('client_cloud_response_too_large'));return;}chunks.push(chunk);});
    response.on('error',reject);response.on('end',()=>{const data=Buffer.concat(chunks).toString('utf8');resolve({ok:response.statusCode>=200&&response.statusCode<300,status:response.statusCode,json:async()=>JSON.parse(data)});});
   });
   request.on('error',reject);if(options.body)request.write(options.body);request.end();
  });
 };
}
module.exports={certifiedFetch};
