import {createClient} from 'npm:@supabase/supabase-js@2';
import {createDigestHandler} from './handler.js';
const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
Deno.serve(createDigestHandler({db,secret:Deno.env.get('LINE_DIGEST_CRON_SECRET'),lineToken:Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN'),targetId:Deno.env.get('LINE_TARGET_USER_ID'),enabled:Deno.env.get('LINE_DIGEST_ENABLED')==='true'}));
