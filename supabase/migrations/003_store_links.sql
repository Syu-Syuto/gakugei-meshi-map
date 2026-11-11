-- Apply after 001 and 002. Outbound links only, not Google-derived business data.
begin;
create function public.valid_store_link(kind text,url text) returns boolean language sql immutable set search_path='' as $$
 select case when url='' then true
 when length(url)>2048 or url ~ '[[:space:]]' then false
 when kind='google' then
 url ~ '^https://(www[.])?google[.](com|co[.]jp)/maps([/?#]|$)'
 or url ~ '^https://maps[.]google[.](com|co[.]jp)([/?#]|$)'
 or url ~ '^https://maps[.]app[.]goo[.]gl/[^/?#]+'
 or url ~ '^https://goo[.]gl/maps/[^/?#]+'
 when kind='official' then url ~ '^https://[a-zA-Z0-9.-]+[.][a-zA-Z]{2,}([/?#]|$)'
 else false end;
$$;
alter table public.restaurants add column google_maps_url text not null default '' check(public.valid_store_link('google',google_maps_url));
alter table public.restaurants add column official_url text not null default '' check(public.valid_store_link('official',official_url));
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
 -- Whitelist fields: clients cannot set status, owner, walking distance or approval.
 d:=jsonb_build_object('google_maps_url',coalesce(p->>'google_maps_url',''),'official_url',coalesce(p->>'official_url',''),'name',trim(p->>'name'),'genre',p->>'genre','budget_yen',budget,'bicycle_parking',coalesce(p->>'bicycle_parking','unknown'),'parking_note',coalesce(p->>'parking_note',''),
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
   insert into public.restaurants(google_maps_url,official_url,name,genre,budget_yen,bicycle_parking,parking_note,lat,lng,address,walk_m,source_kind,source_url,source_note,route_note)
   values(coalesce(d->>'google_maps_url',''),coalesce(d->>'official_url',''),d->>'name',d->>'genre',(d->>'budget_yen')::integer,coalesce(d->>'bicycle_parking','unknown'),coalesce(d->>'parking_note',''),(d->>'lat')::double precision,(d->>'lng')::double precision,d->>'address',walk_m,d->>'source_kind',d->>'source_url',d->>'source_note',review_note) returning id into rid;
 end if;
 update public.submissions set status=case when approve then 'approved' else 'rejected' end,
 reviewed_at=now(),reviewed_by=auth.uid(),review_note=moderate_submission.review_note,restaurant_id=rid where id=submission_id;
 return rid;
end;$$;
revoke all on function public.valid_store_link(text,text),public.submit_restaurant(jsonb),public.moderate_submission(uuid,boolean,integer,text) from public,anon,authenticated;
grant execute on function public.submit_restaurant(jsonb),public.moderate_submission(uuid,boolean,integer,text) to authenticated;
commit;
