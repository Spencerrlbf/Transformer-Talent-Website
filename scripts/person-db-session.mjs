// A pg-pool checkout has no pool idle-error listener until it is released.
// Keep one listener for the whole checkout, including operator-held sessions.
const sqlState=/^(?:[0-9][0-9A-Z]|F0|HV|P0|XX)[0-9A-Z]{3}$/;
function transportFailure(error){
 const code=error?.code??'';
 return !sqlState.test(code)||code.startsWith('08')||/^57P0[1-5]$/.test(code)||['FATAL','PANIC'].includes(error?.severity);
}
export async function checkout(pool){
 const raw=await pool.connect();let broken,released=false;
 const onError=error=>{broken??=error;};
 raw.on('error',onError);
 return {
  async query(...args){
   if(released)throw Error('person_database_session_released');
   if(broken)throw broken;
   try{const result=await raw.query(...args);if(broken)throw broken;return result;}
   catch(error){
    const text=typeof args[0]==='string'?args[0]:args[0]?.text;
    if(transportFailure(error)||/^\s*rollback(?:\s|;|$)/i.test(text??''))broken??=error;
    throw error;
   }
  },
  release(error){
   if(released)return;
   released=true;
   // pg-pool restores its idle listener synchronously. Retain ours until then.
   try{raw.release(broken??error);}finally{raw.removeListener('error',onError);}
  },
 };
}
