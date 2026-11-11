-- Workflow extension. Apply once after 008.
begin;
alter table public.restaurants alter column lat drop not null;
alter table public.restaurants alter column lng drop not null;
alter table public.restaurants alter column walk_m drop not null;
alter table public.restaurants add constraint restaurant_coordinate_pair check((lat is null)=(lng is null));
alter table public.restaurants drop constraint restaurants_purposes_check;
alter table public.restaurants add constraint restaurants_purposes_check check(purposes <@ array['普段の食事','打ち上げ','新歓','少人数の集まり','その他']::text[] and cardinality(purposes)<=5);
alter table public.restaurants add column purpose_other text not null default '' check(length(purpose_other)<=250);
alter table public.restaurants add column edit_revision integer not null default 1;
alter table public.submissions add column submission_kind text not null default 'new' check(submission_kind in ('new','addition'));
alter table public.submissions add column target_restaurant_id uuid references public.restaurants(id);
create table public.admin_blank_checks(admin_id uuid not null,scope text not null,subject_id uuid not null,fingerprint text not null,attempts integer not null,primary key(admin_id,scope,subject_id));
create table public.restaurant_edit_events(id bigint generated always as identity primary key,restaurant_id uuid not null references public.restaurants(id),changed_by uuid not null references auth.users(id),changed_at timestamptz not null default now(),before_data jsonb not null,after_data jsonb not null);
create table public.recommendation_groups(id uuid primary key default gen_random_uuid(),restaurant_id uuid not null references public.restaurants(id),menu_name text not null check(length(trim(menu_name)) between 1 and 100),merged_into uuid references public.recommendation_groups(id));
create table public.recommendation_votes(id uuid primary key references public.submissions(id),restaurant_id uuid not null references public.restaurants(id),group_id uuid references public.recommendation_groups(id),author_id uuid not null references auth.users(id),payload jsonb not null,is_visible boolean not null default true,edit_revision integer not null default 1,created_at timestamptz not null default now());
alter table public.admin_blank_checks enable row level security;
alter table public.restaurant_edit_events enable row level security;
alter table public.recommendation_groups enable row level security;
alter table public.recommendation_votes enable row level security;
revoke all on public.admin_blank_checks,public.restaurant_edit_events,public.recommendation_groups,public.recommendation_votes from public,anon,authenticated;
grant select on public.restaurant_edit_events,public.recommendation_groups,public.recommendation_votes to authenticated;
create index recommendation_groups_restaurant_idx on public.recommendation_groups(restaurant_id);
create index recommendation_votes_restaurant_idx on public.recommendation_votes(restaurant_id);
create index recommendation_votes_group_idx on public.recommendation_votes(group_id);
create policy edit_events_admin on public.restaurant_edit_events for select to authenticated using(public.is_admin());
create policy groups_admin on public.recommendation_groups for select to authenticated using(public.is_admin());
create policy votes_admin on public.recommendation_votes for select to authenticated using(public.is_admin());

create function public.workflow_payload(p jsonb) returns jsonb language plpgsql set search_path='' as $$
declare d jsonb; budget integer; paths text[];
begin
 if jsonb_typeof(p) is distinct from 'object' then raise exception '入力形式を確認してください'; end if;
 if length(trim(coalesce(p->>'name',''))) not between 1 and 100
 or coalesce(p->>'genre','') not in ('定食','ラーメン','うどん・そば','カレー','和食','寿司・海鮮','中華','韓国料理','洋食','イタリアン','焼肉・肉料理','居酒屋','カフェ','パン・サンドイッチ','ファストフード','スイーツ','アジア・エスニック','その他')
 or length(coalesce(p->>'address',''))>250
 or length(coalesce(p->>'source_note',''))>1000
 or coalesce(p->>'source_kind','') not in ('osm','official','field')
 or not public.valid_source(p->>'source_kind',coalesce(p->>'source_url','')) then raise exception '店名・ジャンル・確認情報を確認してください'; end if;
 if ((p->>'lat') is null) <> ((p->>'lng') is null) then raise exception '緯度・経度は両方指定するか、未指定にしてください'; end if;
 if (p->>'lat')::double precision not between 35.67 and 35.74 or (p->>'lng')::double precision not between 139.45 and 139.53 then raise exception '対象範囲の場所を指定してください'; end if;
 if p->>'budget_yen' is not null then
   if (p->>'budget_yen') !~ '^[0-9]{1,6}$' then raise exception '予算は整数です'; end if;
   budget:=(p->>'budget_yen')::integer;
   if budget not in (500,700,1000,1500,2000) then raise exception '予算は選択肢から選んでください'; end if;
 end if;
 if coalesce(p->>'bicycle_parking','unknown') not in ('yes','no','unknown') or length(coalesce(p->>'parking_note',''))>250 then raise exception '駐輪情報を確認してください'; end if;
 if not public.valid_store_link('google',coalesce(p->>'google_maps_url','')) or not public.valid_store_link('official',coalesce(p->>'official_url','')) then raise exception '店舗リンクのURLを確認してください'; end if;
 if length(coalesce(p->>'recommended_menu',''))>100 or length(coalesce(p->>'highlight',''))>100 then raise exception 'おすすめ情報は100文字以内です'; end if;
 if p->>'menu_price_yen' is not null then
 if (p->>'menu_price_yen') !~ '^[0-9]{1,6}$' then raise exception 'メニュー価格は整数です'; end if;
 if (p->>'menu_price_yen')::integer not between 0 and 100000 or length(trim(coalesce(p->>'recommended_menu','')))=0 then raise exception 'メニュー名と価格を確認してください'; end if;
 end if;
 if p ? 'purposes' then
 if jsonb_typeof(p->'purposes') is distinct from 'array' then raise exception '目的は選択式です'; end if;
 if jsonb_array_length(p->'purposes')>5 or not ((p->'purposes') <@ '["普段の食事","打ち上げ","新歓","少人数の集まり","その他"]'::jsonb) then raise exception '目的を確認してください'; end if;
 if jsonb_array_length(p->'purposes')<>(select count(distinct value) from jsonb_array_elements_text(p->'purposes')) then raise exception '目的が重複しています'; end if;
 end if;
 if length(coalesce(p->>'purpose_note',''))>250 then raise exception '目的の補足は250文字以内です'; end if;
 if coalesce(p->>'submitter_gender','') not in ('','male','female') then raise exception '性別は選択式です'; end if;

 if length(coalesce(p->>'purpose_other',''))>250 then raise exception 'その他の目的は250文字以内です'; end if;
 if p->>'walk_m' is not null and ((p->>'walk_m')::integer not between 1 and 2000) then raise exception '歩行距離は1〜2000m、または空欄で入力してください'; end if;
 paths:=case when p ? 'photo_paths' then array(select jsonb_array_elements_text(p->'photo_paths')) when coalesce(p->>'photo_path','')<>'' then array[p->>'photo_path'] else '{}'::text[] end;
 if not public.valid_photo_paths(paths) then raise exception '写真の形式を確認してください'; end if;
 d:=jsonb_build_object('purposes',coalesce(p->'purposes','[]'::jsonb),'purpose_note',coalesce(p->>'purpose_note',''),'purpose_other',coalesce(p->>'purpose_other',''),'walk_m',(p->>'walk_m')::integer,'submitter_gender',coalesce(p->>'submitter_gender',''),'photo_paths',to_jsonb(paths),'photo_path',coalesce(paths[1],''),'photo_confirmed',coalesce(p->>'photo_confirmed','')='true','recommended_menu',trim(coalesce(p->>'recommended_menu','')),'menu_price_yen',(p->>'menu_price_yen')::integer,'highlight',trim(coalesce(p->>'highlight','')),'google_maps_url',coalesce(p->>'google_maps_url',''),'official_url',coalesce(p->>'official_url',''),'name',trim(p->>'name'),'genre',p->>'genre','budget_yen',budget,'bicycle_parking',coalesce(p->>'bicycle_parking','unknown'),'parking_note',coalesce(p->>'parking_note',''),
 'lat',(p->>'lat')::double precision,'lng',(p->>'lng')::double precision,
 'address',coalesce(p->>'address',''),'source_kind',p->>'source_kind',
 'source_url',coalesce(p->>'source_url',''),'source_note',trim(coalesce(p->>'source_note','')),'confirmed',true);

 return d;
end;$$;
revoke all on function public.workflow_payload(jsonb) from public,anon,authenticated;

create function public.workflow_blank_check(scope_name text,subject uuid,d jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare missing text[]:='{}'; n integer;
begin
 if not public.is_admin() then raise exception '管理者権限が必要です'; end if;
 if d->>'lat' is null then missing:=array_append(missing,'緯度・経度'); end if;
 if d->>'walk_m' is null then missing:=array_append(missing,'大学からの徒歩距離'); end if;
 if coalesce(d->>'address','')='' then missing:=array_append(missing,'住所'); end if;
 if d->>'budget_yen' is null then missing:=array_append(missing,'予算'); end if;
 if jsonb_array_length(d->'purposes')=0 then missing:=array_append(missing,'利用目的'); end if;
 if d->'purposes' ? 'その他' and coalesce(d->>'purpose_other','')='' then missing:=array_append(missing,'その他の目的'); end if;
 if cardinality(missing)=0 then return jsonb_build_object('ready',true); end if;
 insert into public.admin_blank_checks(admin_id,scope,subject_id,fingerprint,attempts) values(auth.uid(),scope_name,subject,md5(d::text),1)
 on conflict(admin_id,scope,subject_id) do update set fingerprint=excluded.fingerprint,attempts=case when admin_blank_checks.fingerprint=excluded.fingerprint then least(admin_blank_checks.attempts+1,3) else 1 end returning attempts into n;
 return jsonb_build_object('ready',n>=3,'attempt',n,'missing',missing);
end;$$;
revoke all on function public.workflow_blank_check(text,uuid,jsonb) from public,anon,authenticated;

alter function public.submit_restaurant(jsonb) rename to submit_restaurant_v8_private;
revoke all on function public.submit_restaurant_v8_private(jsonb) from public,anon,authenticated;
create function public.submit_restaurant(p jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare prepared jsonb:=p; sid uuid; target uuid; r public.restaurants; other_text text;
begin
 if auth.uid() is null then raise exception '認証が必要です'; end if;
 if jsonb_typeof(p->'purposes') is distinct from 'array' or jsonb_array_length(p->'purposes')=0 then raise exception '向いている目的を1つ以上選んでください'; end if;
 if jsonb_array_length(p->'purposes')>5 or not (p->'purposes' <@ '["普段の食事","打ち上げ","新歓","少人数の集まり","その他"]'::jsonb) or jsonb_array_length(p->'purposes')<>(select count(distinct value) from jsonb_array_elements_text(p->'purposes')) then raise exception '利用目的を確認してください'; end if;
 other_text:=case when p->'purposes' ? 'その他' then trim(coalesce(p->>'purpose_other','')) else '' end;
 if length(other_text)>250 or (p->'purposes' ? 'その他' and other_text='') then raise exception 'その他を選んだ場合は具体的な目的を入力してください'; end if;
 target:=nullif(p->>'target_restaurant_id','')::uuid;
 if target is not null then
  select * into r from public.restaurants where id=target and is_published for share;
  if not found then raise exception '追加先の店舗が公開されていません'; end if;
  if coalesce(trim(p->>'recommended_menu'),'')='' and coalesce(trim(p->>'highlight'),'')='' and p->>'budget_yen' is null and coalesce(jsonb_array_length(p->'photo_paths'),0)=0 then raise exception '写真・費用・おすすめなどを入力してください'; end if;
  prepared:=to_jsonb(r)||p||jsonb_build_object('name',r.name,'genre',r.genre,'address',r.address,'lat',null,'lng',null);
 end if;
 prepared:=prepared||jsonb_build_object('purposes',coalesce((select jsonb_agg(value) from jsonb_array_elements_text(p->'purposes') where value<>'その他'),'[]'::jsonb));
 sid:=public.submit_restaurant_v8_private(prepared);
 update public.submissions set payload=payload||jsonb_build_object('purposes',p->'purposes','purpose_other',other_text),submission_kind=case when target is null then 'new' else 'addition' end,target_restaurant_id=target where id=sid;
 return sid;
end;$$;
revoke all on function public.submit_restaurant(jsonb) from public,anon,authenticated;
grant execute on function public.submit_restaurant(jsonb) to authenticated;

create function public.workflow_link_vote(rid uuid,sid uuid,d jsonb,merge_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare gid uuid; who uuid; menu text:=trim(coalesce(d->>'recommended_menu',''));
begin
 if merge_id is not null then
  select id,menu_name into gid,menu from public.recommendation_groups where id=merge_id and restaurant_id=rid and merged_into is null;
  if not found then raise exception 'まとめ先のおすすめを確認してください'; end if;
 elsif menu<>'' then
  insert into public.recommendation_groups(restaurant_id,menu_name) values(rid,menu) returning id into gid;
 end if;
 select submitter_id into who from public.submissions where id=sid;
 insert into public.recommendation_votes(id,restaurant_id,group_id,author_id,payload) values(sid,rid,gid,who,d||jsonb_build_object('recommended_menu',menu));
end;$$;
revoke all on function public.workflow_link_vote(uuid,uuid,jsonb,uuid) from public,anon,authenticated;

create function public.review_submission(submission_id uuid,approve boolean,review_data jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.submissions; d jsonb; rid uuid; ack jsonb; merge_id uuid;
begin
 if not public.is_admin() then raise exception '管理者権限が必要です'; end if;
 perform pg_advisory_xact_lock(128741235);
 select * into s from public.submissions where id=submission_id for update;
 if not found or s.status<>'pending' then raise exception '投稿が見つからないか処理済みです'; end if;
 if approve is null then raise exception '審査結果が必要です'; end if;
 if not approve and length(trim(coalesce(review_data->>'rejection_reason',''))) not between 1 and 500 then raise exception '却下理由を入力してください'; end if;
 if approve then
  d:=public.workflow_payload(s.payload||review_data);
  if exists(select 1 from jsonb_array_elements_text(d->'photo_paths') x where not (coalesce(s.payload->'photo_paths',jsonb_build_array(nullif(s.payload->>'photo_path',''))) ? x)) then raise exception '写真は投稿された写真から選んでください'; end if;
  if s.submission_kind='new' then
   ack:=public.workflow_blank_check('approve',submission_id,d);if not (ack->>'ready')::boolean then return ack; end if;
   if exists(select 1 from public.restaurants r where lower(trim(r.name))=lower(trim(d->>'name')) and ((d->>'lat' is not null and abs(r.lat-(d->>'lat')::double precision)<0.001 and abs(r.lng-(d->>'lng')::double precision)<0.001) or (coalesce(d->>'address','')<>'' and r.address=d->>'address'))) then raise exception '同名の近隣店舗が登録されています'; end if;
   insert into public.restaurants(purpose_other,submitter_gender,photo_paths,purposes,purpose_note,photo_path,recommended_menu,menu_price_yen,highlight,google_maps_url,official_url,name,genre,budget_yen,bicycle_parking,parking_note,lat,lng,address,walk_m,source_kind,source_url,source_note,route_note)
   values(coalesce(d->>'purpose_other',''),coalesce(d->>'submitter_gender',''),case when d ? 'photo_paths' then array(select jsonb_array_elements_text(d->'photo_paths')) when coalesce(d->>'photo_path','')<>'' then array[d->>'photo_path'] else '{}'::text[] end,array(select jsonb_array_elements_text(coalesce(d->'purposes','[]'::jsonb))),coalesce(d->>'purpose_note',''),coalesce(d->>'photo_path',''),coalesce(d->>'recommended_menu',''),(d->>'menu_price_yen')::integer,coalesce(d->>'highlight',''),coalesce(d->>'google_maps_url',''),coalesce(d->>'official_url',''),d->>'name',d->>'genre',(d->>'budget_yen')::integer,coalesce(d->>'bicycle_parking','unknown'),coalesce(d->>'parking_note',''),(d->>'lat')::double precision,(d->>'lng')::double precision,d->>'address',(d->>'walk_m')::integer,d->>'source_kind',d->>'source_url',d->>'source_note','') returning id into rid;

  else
   rid:=s.target_restaurant_id;
   perform 1 from public.restaurants where id=rid for update;if not found then raise exception '追加先が見つかりません'; end if;
  end if;
  merge_id:=nullif(review_data->>'merge_group_id','')::uuid;
  perform public.workflow_link_vote(rid,s.id,d,merge_id);
 end if;
 update public.submissions set status=case when approve then 'approved' else 'rejected' end,reviewed_at=now(),reviewed_by=auth.uid(),review_note=case when approve then '' else trim(review_data->>'rejection_reason') end,restaurant_id=rid where id=submission_id;
 delete from public.admin_blank_checks where subject_id=submission_id and scope='approve';
 return jsonb_build_object('ready',true,'restaurant_id',rid);
end;$$;
revoke all on function public.review_submission(uuid,boolean,jsonb) from public,anon,authenticated;
grant execute on function public.review_submission(uuid,boolean,jsonb) to authenticated;

create function public.edit_restaurant(restaurant_id uuid,p jsonb,expected_revision integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.restaurants; d jsonb; ack jsonb; paths text[]; initial_sid uuid; gid uuid;
begin
 if not public.is_admin() then raise exception '管理者権限が必要です'; end if;
 perform pg_advisory_xact_lock(128741235);
 select * into r from public.restaurants where id=restaurant_id for update;
 if not found then raise exception '店舗が見つかりません'; end if;
 if expected_revision is distinct from r.edit_revision then raise exception '内容が変更されています。再読み込みしてください'; end if;
 d:=public.workflow_payload(to_jsonb(r)||p);
 paths:=array(select jsonb_array_elements_text(d->'photo_paths'));
 if not (paths <@ (r.photo_paths||case when r.photo_path<>'' then array[r.photo_path] else '{}'::text[] end)) then raise exception '写真は登録済みの写真から選んでください'; end if;
 ack:=public.workflow_blank_check('edit',restaurant_id,d);if not (ack->>'ready')::boolean then return ack; end if;
 insert into public.restaurant_edit_events(restaurant_id,changed_by,before_data,after_data) values(restaurant_id,auth.uid(),to_jsonb(r),d);
 update public.restaurants set name=d->>'name',genre=d->>'genre',address=d->>'address',budget_yen=(d->>'budget_yen')::integer,lat=(d->>'lat')::double precision,lng=(d->>'lng')::double precision,walk_m=(d->>'walk_m')::integer,google_maps_url=d->>'google_maps_url',official_url=d->>'official_url',source_url=d->>'source_url',source_kind=d->>'source_kind',source_note=d->>'source_note',purpose_other=d->>'purpose_other',purposes=array(select jsonb_array_elements_text(d->'purposes')),purpose_note=d->>'purpose_note',bicycle_parking=d->>'bicycle_parking',parking_note=d->>'parking_note',recommended_menu=d->>'recommended_menu',menu_price_yen=(d->>'menu_price_yen')::integer,highlight=d->>'highlight',submitter_gender=d->>'submitter_gender',photo_paths=paths,photo_path=coalesce(paths[1],''),edit_revision=r.edit_revision+1 where id=restaurant_id;
 -- Keep the original recommendation consistent with edits, without changing other contributors.
 update public.recommendation_votes v set payload=d,edit_revision=v.edit_revision+1 from public.submissions s where s.id=v.id and s.restaurant_id=edit_restaurant.restaurant_id and s.submission_kind='new' and v.is_visible;

 if r.recommended_menu is distinct from d->>'recommended_menu' then
  select v.id into initial_sid from public.recommendation_votes v join public.submissions s on s.id=v.id where s.restaurant_id=edit_restaurant.restaurant_id and s.submission_kind='new' and v.is_visible limit 1;
  if initial_sid is not null then
   if coalesce(d->>'recommended_menu','')<>'' then insert into public.recommendation_groups(restaurant_id,menu_name) values(restaurant_id,d->>'recommended_menu') returning id into gid; end if;
   update public.recommendation_votes set group_id=gid where id=initial_sid;
  end if;
 end if;
 delete from public.admin_blank_checks where admin_id=auth.uid() and scope='edit' and subject_id=restaurant_id;
 return jsonb_build_object('ready',true);
end;$$;
revoke all on function public.edit_restaurant(uuid,jsonb,integer) from public,anon,authenticated;
grant execute on function public.edit_restaurant(uuid,jsonb,integer) to authenticated;

create function public.restaurant_extras(rid uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not exists(select 1 from public.restaurants where id=rid and (is_published or public.is_admin())) then return jsonb_build_object('groups','[]'::jsonb,'posts','[]'::jsonb); end if;
 return jsonb_build_object(
 'has_managed_posts',exists(select 1 from public.recommendation_votes where restaurant_id=rid),
 'groups',coalesce((select jsonb_agg(x order by x->>'name') from (select jsonb_build_object('id',g.id,'name',g.menu_name,'count',(select count(distinct v.author_id) from public.recommendation_votes v where v.group_id=g.id and v.is_visible)) x from public.recommendation_groups g where g.restaurant_id=rid and g.merged_into is null and exists(select 1 from public.recommendation_votes visible_vote where visible_vote.group_id=g.id and visible_vote.is_visible)) q),'[]'::jsonb),
 'posts',coalesce((select jsonb_agg(jsonb_build_object('id',v.id,'group_id',v.group_id,'recommended_menu',v.payload->>'recommended_menu','menu_price_yen',v.payload->'menu_price_yen','budget_yen',v.payload->'budget_yen','highlight',v.payload->>'highlight','submitter_gender',v.payload->>'submitter_gender','photo_paths',coalesce(v.payload->'photo_paths','[]'::jsonb),'purpose_other',v.payload->>'purpose_other','purpose_note',v.payload->>'purpose_note','created_at',v.created_at) order by v.created_at) from public.recommendation_votes v where v.restaurant_id=rid and v.is_visible),'[]'::jsonb));
end;$$;
revoke all on function public.restaurant_extras(uuid) from public,anon,authenticated;
grant execute on function public.restaurant_extras(uuid) to anon,authenticated;

create function public.manage_recommendation(source_id uuid,target_id uuid,new_name text) returns void language plpgsql security definer set search_path='' as $$
declare a public.recommendation_groups; b public.recommendation_groups;
begin
 if not public.is_admin() then raise exception '管理者権限が必要です'; end if;
 perform pg_advisory_xact_lock(128741235);
 select * into a from public.recommendation_groups where id=source_id and merged_into is null for update;if not found then raise exception 'おすすめが見つかりません'; end if;
 if target_id is not null then
  select * into b from public.recommendation_groups where id=target_id and restaurant_id=a.restaurant_id and merged_into is null for update;
  if not found or source_id=target_id then raise exception 'まとめ先を確認してください'; end if;
  update public.recommendation_votes set group_id=target_id,edit_revision=edit_revision+1 where group_id=source_id;
  update public.recommendation_groups set merged_into=target_id where id=source_id;
 elsif length(trim(coalesce(new_name,''))) between 1 and 100 then update public.recommendation_groups set menu_name=trim(new_name) where id=source_id;
 else raise exception 'メニュー名を入力してください'; end if;
end;$$;
revoke all on function public.manage_recommendation(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.manage_recommendation(uuid,uuid,text) to authenticated;

create function public.edit_recommendation_post(post_id uuid,p jsonb,visible boolean,expected_revision integer) returns void language plpgsql security definer set search_path='' as $$
declare v public.recommendation_votes; d jsonb; gid uuid; paths text[];
begin
 if not public.is_admin() then raise exception '管理者権限が必要です'; end if;
 perform pg_advisory_xact_lock(128741235);
 select * into v from public.recommendation_votes where id=post_id for update;if not found or v.edit_revision is distinct from expected_revision then raise exception '内容が変更されています。再読み込みしてください'; end if;
 d:=public.workflow_payload(v.payload||p);
 if not (array(select jsonb_array_elements_text(d->'photo_paths')) <@ array(select jsonb_array_elements_text(v.payload->'photo_paths'))) then raise exception '写真は投稿済みの写真から選んでください'; end if;
 if v.payload->>'recommended_menu' is distinct from d->>'recommended_menu' then
  if coalesce(d->>'recommended_menu','')<>'' then insert into public.recommendation_groups(restaurant_id,menu_name) values(v.restaurant_id,d->>'recommended_menu') returning id into gid; end if;
  update public.recommendation_votes set group_id=gid where id=post_id;
 end if;
 if exists(select 1 from public.submissions where id=post_id and submission_kind='new') then
  paths:=case when visible then array(select jsonb_array_elements_text(d->'photo_paths')) else '{}'::text[] end;
  update public.restaurants set photo_paths=paths,photo_path=coalesce(paths[1],''),recommended_menu=case when visible then d->>'recommended_menu' else '' end,menu_price_yen=case when visible then (d->>'menu_price_yen')::integer else null end,highlight=case when visible then d->>'highlight' else '' end,edit_revision=edit_revision+1 where id=v.restaurant_id;
 end if;
 insert into public.restaurant_edit_events(restaurant_id,changed_by,before_data,after_data) values(v.restaurant_id,auth.uid(),v.payload,d);
 update public.recommendation_votes set payload=d,is_visible=visible,edit_revision=v.edit_revision+1 where id=post_id;
end;$$;
revoke all on function public.edit_recommendation_post(uuid,jsonb,boolean,integer) from public,anon,authenticated;
grant execute on function public.edit_recommendation_post(uuid,jsonb,boolean,integer) to authenticated;

-- Existing approved submissions retain their actual author identity for counts.
insert into public.recommendation_groups(restaurant_id,menu_name) select id,recommended_menu from public.restaurants where trim(recommended_menu)<>'';
insert into public.recommendation_votes(id,restaurant_id,group_id,author_id,payload,created_at)
select s.id,r.id,(select g.id from public.recommendation_groups g where g.restaurant_id=r.id limit 1),s.submitter_id,to_jsonb(r)||jsonb_build_object('confirmed',true,'photo_confirmed',true),s.created_at from public.submissions s join public.restaurants r on r.id=s.restaurant_id where s.status='approved';

create or replace function public.can_read_restaurant_photo(object_name text) returns boolean language sql stable security definer set search_path='' as $$
 select public.is_admin()
 or exists(select 1 from public.restaurants r where r.is_published and (r.photo_path=object_name or object_name=any(r.photo_paths)))
 or exists(select 1 from public.recommendation_votes v join public.restaurants r on r.id=v.restaurant_id where r.is_published and v.is_visible and v.payload->'photo_paths' ? object_name)
 or exists(select 1 from public.photo_uploads u where u.path=object_name and u.user_id=auth.uid() and (u.submission_id is null or exists(select 1 from public.submissions s where s.id=u.submission_id and s.status='pending')));
$$;
commit;
