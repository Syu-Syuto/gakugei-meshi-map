-- Apply once after 006. Existing approved restaurants remain public.
begin;
alter table public.restaurants add column is_published boolean not null default true;
create table public.restaurant_visibility_events(
 id bigint generated always as identity primary key,
 restaurant_id uuid not null references public.restaurants(id),
 is_published boolean not null,
 changed_by uuid not null references auth.users(id),
 changed_at timestamptz not null default now()
);
alter table public.restaurant_visibility_events enable row level security;
revoke all on public.restaurant_visibility_events from public,anon,authenticated;
grant select on public.restaurant_visibility_events to authenticated;
create policy visibility_events_admin_read on public.restaurant_visibility_events for select to authenticated using(public.is_admin());

drop policy restaurants_read on public.restaurants;
create policy restaurants_public_read on public.restaurants for select to anon,authenticated using(is_published);
create policy restaurants_admin_read on public.restaurants for select to authenticated using(public.is_admin());
drop policy reviews_read on public.reviews;
create policy reviews_read on public.reviews for select using(
 status='approved' and exists(select 1 from public.restaurants r where r.id=restaurant_id and r.is_published)
);

create function public.set_restaurant_visibility(restaurant_id uuid,published boolean,expected_published boolean)
returns boolean language plpgsql security definer set search_path='' as $$
declare current_visibility boolean;
begin
 if not public.is_admin() then raise exception '管理者権限が必要です'; end if;
 if published is null or expected_published is null then raise exception '公開状態を指定してください'; end if;
 select r.is_published into current_visibility from public.restaurants r where r.id=restaurant_id for update;
 if not found then raise exception '店舗が見つかりません'; end if;
 if current_visibility is distinct from expected_published then raise exception '公開状態が変更されています。再読み込みしてください'; end if;
 if current_visibility=published then return published; end if;
 update public.restaurants r set is_published=published where r.id=restaurant_id;
 insert into public.restaurant_visibility_events(restaurant_id,is_published,changed_by) values(restaurant_id,published,auth.uid());
 return published;
end;$$;
revoke all on function public.set_restaurant_visibility(uuid,boolean,boolean) from public,anon,authenticated;
grant execute on function public.set_restaurant_visibility(uuid,boolean,boolean) to authenticated;

-- Owners can preview unsubmitted/pending photos, but not keep access to a hidden
-- approved restaurant. Only admins can read hidden restaurants' photos.
create or replace function public.can_read_restaurant_photo(object_name text) returns boolean
language sql stable security definer set search_path='' as $$
 select public.is_admin()
 or exists(select 1 from public.restaurants r where r.is_published and (r.photo_path=object_name or object_name=any(r.photo_paths)))
 or exists(
  select 1 from public.photo_uploads u where u.path=object_name and u.user_id=auth.uid()
  and not exists(select 1 from public.restaurants r where r.photo_path=object_name or object_name=any(r.photo_paths))
  and (u.submission_id is null or exists(select 1 from public.submissions s where s.id=u.submission_id and s.status='pending'))
 );
$$;
commit;
