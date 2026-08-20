-- Supabase 대시보드 > SQL Editor 에 붙여넣고 실행한다.
-- 테이블 두 개를 만들고, 익명 키로 읽고 쓸 수 있게 연다.

create table if not exists faq (
  id       text primary key,
  cert     text not null,
  title    text not null,
  text     text not null,
  keywords text[] default '{}'
);

create table if not exists synonyms (
  short text primary key,
  full  text not null
);

-- 실습용 공개 설정이다. 익명 키를 가진 사람은 누구나 읽고 쓸 수 있다.
alter table faq      enable row level security;
alter table synonyms enable row level security;

drop policy if exists "faq open"  on faq;
drop policy if exists "syn open"  on synonyms;
create policy "faq open" on faq      for all using (true) with check (true);
create policy "syn open" on synonyms for all using (true) with check (true);
