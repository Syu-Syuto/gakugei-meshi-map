import {createClient} from 'npm:@supabase/supabase-js@2';
const origin=Deno.env.get('ALLOWED_ORIGIN') || '';
const headers={'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info','Access-Control-Allow-Methods':'POST, OPTIONS','Vary':'Origin'};
const respond=(status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers:{...headers,'Content-Type':'application/json'}});
Deno.serve(async(req)=>{
 if(!origin || req.headers.get('origin')!==origin)return respond(403,{error:'Origin not allowed'});
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
 if(req.method!=='POST')return respond(405,{error:'POST required'});
 const supabase=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
 const token=(req.headers.get('authorization')||'').replace(/^Bearer /,'');
 const {data:auth,error:authError}=await supabase.auth.getUser(token);
 if(authError||!auth.user)return respond(401,{error:'Authentication required'});
 try{
   const raw=await req.text();if(raw.length>1000)return respond(413,{error:'Request too large'});
   const {query}=JSON.parse(raw);
   if(typeof query!=='string'||query.trim().length<2||query.length>100)return respond(400,{error:'Invalid query'});
   const limit=await supabase.rpc('take_api_slot',{who:auth.user.id,bucket_name:'osm-search',max_hits:20});
   if(limit.error||!limit.data)return respond(429,{error:'Search limit reached'});
   const cacheId='koganei-food-v1';
   const cached=await supabase.from('osm_cache').select('data,updated_at').eq('id',cacheId).maybeSingle();
   if(cached.error)throw new Error('Cache unavailable');
   let items=cached.data?.data;
   if(!cached.data||Date.now()-Date.parse(cached.data.updated_at)>86400000){
     // Global refresh lease prevents simultaneous visitors from issuing duplicate queries.
     const lease=await supabase.rpc('take_api_slot',{who:'00000000-0000-0000-0000-000000000001',bucket_name:'osm-refresh',max_hits:1});
     if(lease.error||!lease.data){if(!items)return respond(503,{error:'Candidate search temporarily unavailable; use manual entry'});}
     else{
       const endpoint=Deno.env.get('OVERPASS_URL')||'https://overpass-api.de/api/interpreter';
       if(!endpoint.startsWith('https://'))throw new Error('HTTPS endpoint required');
       // Fixed bounded query. User input is NEVER interpolated into Overpass QL or a fetch URL.
       const q='[out:json][timeout:20];nwr["amenity"~"^(restaurant|cafe|fast_food|food_court)$"]["name"](35.683,139.463,35.730,139.520);out center tags;';
       const res=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':Deno.env.get('OSM_USER_AGENT')||'GakugeiMeshiMap/0.1'},body:new URLSearchParams({data:q}),signal:AbortSignal.timeout(25000)});
       if(!res.ok)throw new Error('OSM unavailable');const body=await res.json();
       if(!Array.isArray(body.elements))throw new Error('Invalid OSM response');
       items=body.elements.map((o:any)=>({name:o.tags?.name,lat:o.lat??o.center?.lat,lng:o.lon??o.center?.lon,address:[o.tags?.['addr:city'],o.tags?.['addr:suburb'],o.tags?.['addr:street'],o.tags?.['addr:housenumber']].filter(Boolean).join(''),source_url:`https://www.openstreetmap.org/${o.type}/${o.id}`})).filter((o:any)=>typeof o.name==='string'&&o.name.length<=100&&Number.isFinite(o.lat)&&Number.isFinite(o.lng));
       const saved=await supabase.from('osm_cache').upsert({id:cacheId,data:items,updated_at:new Date().toISOString()});if(saved.error)throw new Error('Cache unavailable');
     }
   }
   const key=query.normalize('NFKC').toLowerCase().trim();
   return respond(200,{candidates:items.filter((o:any)=>o.name.normalize('NFKC').toLowerCase().includes(key)).slice(0,12),attribution:'© OpenStreetMap contributors',license:'ODbL-1.0'});
 }catch{return respond(503,{error:'Candidate search unavailable. Please use manual entry.'});}
});
