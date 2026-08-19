-- =============================================================
-- 담당자가 채우는 칸 추가
--
-- 실행 위치: Supabase 대시보드 > SQL Editor > New query > Run
-- 실행 횟수: 1회
--
-- [왜 필요한가]
--   우리 접수 폼은 이름·연락처·자격증만 받습니다 (접수대장 7칸).
--   그런데 통합 내역과 나란히 놓으면 성별·시험장 같은 칸이 비어 있습니다.
--   담당자가 전화로 확인한 뒤 그 칸을 채울 수 있어야 합니다.
--
-- [원본은 그대로 둡니다]
--   신청자가 낸 값(name, phone, certificate, channel, note)은
--   담당자도 고칠 수 없습니다. 아래 트리거가 DB에서 막습니다.
--   담당자는 새로 만든 staff_ 칸만 채웁니다.
-- =============================================================


-- 1) 담당자가 채우는 칸 ------------------------------------------

alter table public.applications
  add column if not exists staff_birth       text,   -- 생년월일
  add column if not exists staff_gender      text,   -- 성별
  add column if not exists staff_region      text,   -- 시험지역
  add column if not exists staff_center      text,   -- 시험장
  add column if not exists staff_exam_date   text,   -- 시험일자
  add column if not exists staff_pay_method  text,   -- 결제수단
  add column if not exists staff_pay_status  text,   -- 결제상태
  add column if not exists staff_app_status  text,   -- 접수상태
  add column if not exists staff_memo        text,   -- 담당자 메모
  add column if not exists staff_updated_at  timestamptz;

comment on column public.applications.staff_birth is
  '담당자가 전화로 확인해 채운 값. 신청자가 낸 값이 아닙니다.';


-- 2) 원본 칸 잠금 -----------------------------------------------
-- 담당자가 실수로 신청자의 값을 덮어쓰지 못하게 DB가 막습니다.
-- 원장 문제 10번 — "나중에 저장한 쪽이 앞의 것을 덮어씀" 과 같은 사고 방지.

create or replace function public.applications_lock_original()
returns trigger language plpgsql as $$
begin
  if new.name        is distinct from old.name        then raise exception '이름은 고칠 수 없습니다'; end if;
  if new.phone       is distinct from old.phone       then raise exception '연락처는 고칠 수 없습니다'; end if;
  if new.certificate is distinct from old.certificate then raise exception '신청 자격증은 고칠 수 없습니다'; end if;
  if new.channel     is distinct from old.channel     then raise exception '접수경로는 고칠 수 없습니다'; end if;
  if new.note        is distinct from old.note        then raise exception '비고는 고칠 수 없습니다'; end if;
  if new.created_at  is distinct from old.created_at  then raise exception '접수일은 고칠 수 없습니다'; end if;

  new.staff_updated_at := now();   -- 담당자가 손댄 때를 자동 기록
  return new;
end $$;

drop trigger if exists applications_lock_original_trg on public.applications;

create trigger applications_lock_original_trg
  before update on public.applications
  for each row execute function public.applications_lock_original();


-- 3) 담당자가 채울 수 있게 권한 열기 ------------------------------
-- 지우기는 열지 않습니다. 한 번 들어온 접수는 아무도 못 지웁니다.

drop policy if exists "담당자: 확인한 내용 채우기" on public.applications;

create policy "담당자: 확인한 내용 채우기"
  on public.applications
  for update to anon
  using (true) with check (true);


-- 4) 확인 -------------------------------------------------------

select column_name
from information_schema.columns
where table_name = 'applications' and column_name like 'staff%'
order by column_name;

select policyname, cmd from pg_policies where tablename = 'applications' order by cmd;
