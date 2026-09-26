import net from 'node:net';
export function denyOutboundExceptDatabase(port) {
 const connect=net.Socket.prototype.connect,fetch=globalThis.fetch;
 const allowed=new Set(['localhost','127.0.0.1','::1']);
 net.Socket.prototype.connect=function(...args){
  const first=Array.isArray(args[0])?args[0][0]:args[0];
  const options=first&&typeof first==='object'?first:{port:first,host:typeof args[1]==='string'?args[1]:'localhost'};
  if(options.path||Number(options.port)!==port||!allowed.has(options.host??'localhost'))throw Error('canary_outbound_denied');
  return Reflect.apply(connect,this,args);
 };
 globalThis.fetch=async()=>{throw Error('canary_outbound_denied');};
 return ()=>{net.Socket.prototype.connect=connect;globalThis.fetch=fetch;};
}
