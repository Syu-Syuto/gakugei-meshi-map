-- Apply after migrations 001–004. Configure the private bucket through SQL once.
begin;
alter table public.restaurants add column purposes text[] not null default '{}' check(purposes <@ array['普段の食事','打ち上げ','新歓','少人数の集まり']::text[] and cardinality(purposes)<=4);
alter table public.restaurants add column purpose_note text not null default '' check(length(purpose_note)<=250);
alter table public.restaurants add column photo_path text not null default '' check(photo_path='' or photo_path ~ '^[0-9a-f-]{36}[.]jpg$');
create unique index restaurants_photo_unique on public.restaurants(photo_path) where photo_path<>'';
create unique index submissions_photo_unique on public.submissions((payload->>'photo_path')) where coalesce(payload->>'photo_path','')<>'';
create table public.photo_uploads(path text primary key,user_id uuid not null references auth.users(id),created_at timestamptz not null default now());
create index photo_uploads_by_user on public.photo_uploads(user_id,created_at);
alter table public.photo_uploads enable row level security;
revoke all on public.photo_uploads from public,anon,authenticated;
grant all on public.photo_uploads to service_role;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('restaurant-photos','restaurant-photos',false,3145728,array['image/jpeg']);

create function public.reserve_restaurant_photo() returns text language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); path text:=gen_random_uuid()::text||'.jpg';
begin
 if uid is null then raise exception '認証が必要です'; end if;
 perform pg_advisory_xact_lock(hashtextextended(uid::text,1));
 if (select count(*) from public.photo_uploads where user_id=uid and created_at>now()-interval '1 day')>=5 then raise exception '写真の送信は1日5回までです'; end if;
 insert into public.photo_uploads(path,user_id) values(path,uid);
 return path;
end;$$;
create function public.can_upload_restaurant_photo(object_name text) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.photo_uploads u where u.path=object_name and u.user_id=auth.uid() and u.created_at>now()-interval '1 hour');
$$;
create function public.can_read_restaurant_photo(object_name text) returns boolean language sql stable security definer set search_path='' as $$
 select public.is_admin() or exists(select 1 from public.photo_uploads u where u.path=object_name and u.user_id=auth.uid())
 or exists(select 1 from public.restaurants r where r.photo_path=object_name and r.photo_path<>'');
$$;
create policy restaurant_photo_insert on storage.objects for insert to authenticated with check(
 bucket_id='restaurant-photos' and owner_id=auth.uid()::text and public.can_upload_restaurant_photo(name)
);
create policy restaurant_photo_read on storage.objects for select to anon,authenticated using(
 bucket_id='restaurant-photos' and public.can_read_restaurant_photo(name)
);
-- No client UPDATE or DELETE policy. An approved image cannot be replaced in place.
revoke all on function public.reserve_restaurant_photo(),public.can_upload_restaurant_photo(text),public.can_read_restaurant_photo(text) from public,anon,authenticated;
grant execute on function public.reserve_restaurant_photo(),public.can_upload_restaurant_photo(text) to authenticated;
grant execute on function public.can_read_restaurant_photo(text) to anon,authenticated;
create or replace function public.submit_restaurant(p jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); d jsonb; new_id uuid; budget integer;
begin
 if uid is null then raise exception '認証が必要です'; end if;
 perform pg_advisory_xact_lock(hashtextextended(uid::text,0));
 if (select count(*) from public.submissions where submitter_id=uid and created_at>now()-interval '1 day')>=5 then raise exception '投稿は1日5件までです'; end if;
 if (select count(*) from public.submissions where submitter_id=uid and created_at>now()-interval '60 seconds')>0 then raise exception '次の投稿まで1分お待ちください'; end if;
 if coalesce(p->>'confirmed','')<>'true' or jsonb_typeof(p)<>'object' then raise exception '内容確認が必要です'; end if;
 if length(trim(coalesce(p->>'name',''))) not between 1 and 100
 or coalesce(p->>'genre','') not in ('定食','ラーメン','カレー','カフェ','その他')
 or length(coalesce(p->>'address',''))>250
 or length(trim(coalesce(p->>'source_note',''))) not between 5 and 1000
 or coalesce(p->>'source_kind','') not in ('osm','official','field')
 or not public.valid_source(p->>'source_kind',coalesce(p->>'source_url','')) then raise exception '店名・ジャンル・確認情報を確認してください'; end if;
 if p->>'lat' is null or p->>'lng' is null then raise exception '場所が必要です'; end if;
 if (p->>'lat')::double precision not between 35.67 and 35.74 or (p->>'lng')::double precision not between 139.45 and 139.53 then raise exception '対象範囲の場所を指定してください'; end if;
 if p->>'budget_yen' is not null then
   if (p->>'budget_yen') !~ '^[0-9]{1,6}$' then raise exception '予算は整数です'; end if;
   budget:=(p->>'budget_yen')::integer;
   if budget not in (700,1000,1500) then raise exception '予算は700円程度・1000円程度・1500円程度から選んでください'; end if;
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
 if jsonb_array_length(p->'purposes')>4 or not ((p->'purposes') <@ '["普段の食事","打ち上げ","新歓","少人数の集まり"]'::jsonb) then raise exception '目的を確認してください'; end if;
 if jsonb_array_length(p->'purposes')<>(select count(distinct value) from jsonb_array_elements_text(p->'purposes')) then raise exception '目的が重複しています'; end if;
 end if;
 if length(coalesce(p->>'purpose_note',''))>250 then raise exception '目的の補足は250文字以内です'; end if;
 if coalesce(p->>'photo_path','')<>'' then
 if coalesce(p->>'photo_confirmed','')<>'true' or not exists(
 select 1 from public.photo_uploads u join storage.objects o on o.name=u.path and o.bucket_id='restaurant-photos'
 where u.path=p->>'photo_path' and u.user_id=uid and o.owner_id=uid::text
 and o.metadata->>'mimetype'='image/jpeg' and (o.metadata->>'size')::bigint between 1 and 3145728
 ) then raise exception '写真の所有者・確認事項・アップロードを確認してください'; end if;
 end if;
 -- Whitelist fields: clients cannot set status, owner, walking distance or approval.
 d:=jsonb_build_object('purposes',coalesce(p->'purposes','[]'::jsonb),'purpose_note',coalesce(p->>'purpose_note',''),'photo_path',coalesce(p->>'photo_path',''),'photo_confirmed',coalesce(p->>'photo_confirmed','')='true','recommended_menu',trim(coalesce(p->>'recommended_menu','')),'menu_price_yen',(p->>'menu_price_yen')::integer,'highlight',trim(coalesce(p->>'highlight','')),'google_maps_url',coalesce(p->>'google_maps_url',''),'official_url',coalesce(p->>'official_url',''),'name',trim(p->>'name'),'genre',p->>'genre','budget_yen',budget,'bicycle_parking',coalesce(p->>'bicycle_parking','unknown'),'parking_note',coalesce(p->>'parking_note',''),
 'lat',(p->>'lat')::double precision,'lng',(p->>'lng')::double precision,
 'address',coalesce(p->>'address',''),'source_kind',p->>'source_kind',
 'source_url',coalesce(p->>'source_url',''),'source_note',trim(p->>'source_note'),'confirmed',true);
 insert into public.submissions(submitter_id,payload) values(uid,d) returning id into new_id;
 return new_id;
end;$$;

create or replace function public.moderate_submission(submission_id uuid,approve boolean,walk_m integer,review_note text) returns uuid
language plpgsql security definer set search_path='' as $$
declare s public.submissions; d jsonb; rid uuid;
begin
 if not public.is_admin() then raise exception '管理者権限が必要です'; end if;
 -- Serialize approvals to prevent concurrent duplicate insertion.
 perform pg_advisory_xact_lock(128741235);
 select * into s from public.submissions where id=submission_id for update;
 if not found or s.status<>'pending' then raise exception '投稿が見つからないか処理済みです'; end if;
 if approve is null or length(trim(coalesce(review_note,''))) not between 1 and 1000 then raise exception '審査結果と確認メモが必要です'; end if;
 if approve then
   if walk_m is null or walk_m not between 1 and 2000 or length(trim(review_note))<10 then raise exception '徒歩25分以内の歩行距離と経路の確認記録が必要です'; end if;
   d:=s.payload;
   if exists(select 1 from public.restaurants r where lower(trim(r.name))=lower(trim(d->>'name')) and abs(r.lat-(d->>'lat')::double precision)<0.001 and abs(r.lng-(d->>'lng')::double precision)<0.001) then raise exception '同名の近隣店舗が登録されています'; end if;
   insert into public.restaurants(purposes,purpose_note,photo_path,recommended_menu,menu_price_yen,highlight,google_maps_url,official_url,name,genre,budget_yen,bicycle_parking,parking_note,lat,lng,address,walk_m,source_kind,source_url,source_note,route_note)
   values(array(select jsonb_array_elements_text(coalesce(d->'purposes','[]'::jsonb))),coalesce(d->>'purpose_note',''),coalesce(d->>'photo_path',''),coalesce(d->>'recommended_menu',''),(d->>'menu_price_yen')::integer,coalesce(d->>'highlight',''),coalesce(d->>'google_maps_url',''),coalesce(d->>'official_url',''),d->>'name',d->>'genre',(d->>'budget_yen')::integer,coalesce(d->>'bicycle_parking','unknown'),coalesce(d->>'parking_note',''),(d->>'lat')::double precision,(d->>'lng')::double precision,d->>'address',walk_m,d->>'source_kind',d->>'source_url',d->>'source_note',review_note) returning id into rid;
 end if;
 update public.submissions set status=case when approve then 'approved' else 'rejected' end,
 reviewed_at=now(),reviewed_by=auth.uid(),review_note=moderate_submission.review_note,restaurant_id=rid where id=submission_id;
 return rid;
end;$$;
revoke all on function public.submit_restaurant(jsonb),public.moderate_submission(uuid,boolean,integer,text) from public,anon,authenticated;
grant execute on function public.submit_restaurant(jsonb),public.moderate_submission(uuid,boolean,integer,text) to authenticated;
commit;
