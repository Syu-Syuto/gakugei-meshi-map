const API='https://api.line.me/v2/bot/message';
const result=(code,status)=>new Response(JSON.stringify({status}),{status:code,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
async function sameSecret(a,b){if(!a||!b||b.length<32)return false;const digest=async s=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)));const [x,y]=await Promise.all([digest(a),digest(b)]);let diff=0;for(let i=0;i<x.length;i++)diff|=x[i]^y[i];return diff===0;}
export function createDigestHandler({db,secret,lineToken,targetId,enabled,fetcher=fetch}){return async req=>{
 if(req.method!=='POST')return result(405,'POST required');
 if(!await sameSecret(req.headers.get('x-digest-secret'),secret))return result(401,'Unauthorized');
 if(!enabled||!lineToken||!/^U[0-9a-f]{32}$/.test(targetId||''))return result(503,'Not configured');
 let batch;
 const rpc=async(name,args)=>{const r=await db.rpc(name,args);if(r.error)throw new Error('Database operation failed');return r.data;};
 const finish=async(sent,error='')=>rpc('finish_line_digest',{batch_id:batch.id,lease_id:batch.lease_id,sent,error_code:error});
 const lineFetch=(path,options={})=>fetcher(API+path,{...options,signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+lineToken,...options.headers}});
 try{
  const mode=new URL(req.url).searchParams.get('mode');
  batch=await rpc(mode==='connection_test'?'prepare_line_connection_test':'prepare_line_digest',{recipient:targetId});
  if(!batch||batch.status!=='ready')return result(200,batch?.status||'empty');
  if(batch.body?.to!==targetId){await finish(false,'recipient_changed');return result(503,'Recipient changed');}
  const [quotaReply,usedReply]=await Promise.all([lineFetch('/quota'),lineFetch('/quota/consumption')]);
  if(!quotaReply.ok||!usedReply.ok){await finish(false,'quota_check_failed');return result(502,'Quota check failed');}
  const quota=await quotaReply.json(),used=await usedReply.json();const limit=quota.type==='limited'&&Number.isInteger(quota.value)?Math.min(200,quota.value):200;
  if(!Number.isInteger(used.totalUsage)||used.totalUsage<0||used.totalUsage>=limit){await finish(false,'monthly_quota');return result(200,'Monthly quota reached');}
  const response=await lineFetch('/push',{method:'POST',headers:{'Content-Type':'application/json','X-Line-Retry-Key':batch.id},body:JSON.stringify(batch.body)});
  if(response.ok||response.status===409&&response.headers.has('x-line-accepted-request-id')){await finish(true);return result(200,'sent');}
  await finish(false,'line_http_'+response.status);return result(502,'LINE request failed');
 }catch{if(batch?.status==='ready'){try{await finish(false,'delivery_or_database_error');}catch{/* lease expiration permits a retry at the next scheduled slot */}}return result(502,'Delivery not confirmed');}
};}
