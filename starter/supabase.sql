-- =============================================================
-- 시니어 자격증 접수 서비스 — Supabase 초기 설정
--
-- 실행 위치: Supabase 대시보드 > SQL Editor > New query > 붙여넣고 Run
-- 실행 횟수: 1회
--
-- [설계 원칙] 원본 데이터는 절대 변형하지 않는다
--   - 원본 컬럼에는 제약(check, not null)을 걸지 않는다.
--     이상한 값이 들어와도 거부하지 않고 그대로 받는다.
--   - 판정은 별도의 파생 컬럼에서 하고, 집계·조회는 파생 컬럼을 기준으로 한다.
--   - 판정이 불가능하면 null로 두고 "확인 필요"로 드러낸다. 추측해서 채우지 않는다.
-- =============================================================


-- 1) 접수 테이블 ------------------------------------------------

create table public.applications (

  -- ---------- 자동 부여 ----------
  id          bigint generated always as identity primary key,  -- 접수번호
  created_at  timestamptz not null default now(),               -- 접수일


  -- ---------- 원본 (접수대장.docx 칸 그대로, 제약 없음) ----------
  -- "이 표의 칸이 곧 저희가 받아야 하는 정보입니다" (01_사업현황_발주서.md 79줄)
  -- 입력 검사는 접수 화면에서 안내로 하고, DB는 들어온 값을 거부하지 않습니다.
  -- 나중에 워드 원장 22행을 옮겨 심을 때도 원본이 그대로 보존됩니다.

  name        text,   -- 이름
  phone       text,   -- 연락처 (원장 4행처럼 비어 있을 수 있음)
  certificate text,   -- 신청 자격증 (원장에는 한식 / 한식조리 / 한식조리기능사가 섞여 있음)
  channel     text,   -- 접수경로 (원장에는 전화 / 전화문의가 섞여 있음)
  note        text,   -- 비고


  -- ---------- 판정 (파생, 원본을 건드리지 않음) ----------

  -- 연락처에서 숫자만 뽑은 값. 검색·중복확인용.
  -- 원장 문제 16번 — 010-2345-6789 와 01034567890 이 섞여 있음
  -- DB가 자동 계산하므로 원본과 어긋날 수 없습니다.
  phone_digits text generated always as (
    regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g')
  ) stored,

  -- 자격증 표준명 판정 결과. 어드민 집계는 이 컬럼을 기준으로 셉니다.
  -- 원장 문제 15번 — 한식 / 한식조리 / 한식조리기능사가 같은 것이었음
  -- 판정이 안 되면 null로 두고 "확인 필요"로 드러냅니다. 짐작해서 채우지 않습니다.
  certificate_std text,

  -- 사람이 한 번 봐야 하는 행인지 표시.
  -- 원본을 고치는 대신, "이 행은 확인이 필요하다"는 판단만 따로 답니다.
  review_needed boolean generated always as (
    name is null
    or btrim(name) = ''
    or regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') = ''
    or certificate_std is null
  ) stored
);

comment on table  public.applications         is '자격증 필기 접수 신청 (접수대장.docx 대체). 원본 컬럼은 무제약, 판정은 파생 컬럼에서.';
comment on column public.applications.certificate     is '원본: 신청자가 실제로 낸 값';
comment on column public.applications.certificate_std is '판정: 자격증 8종 표준명. 판정 불가 시 null';
comment on column public.applications.phone_digits    is '판정: 연락처에서 숫자만 추출 (자동 계산)';
comment on column public.applications.review_needed   is '판정: 사람이 확인해야 하는 행 (자동 계산)';


-- 2) 조회 인덱스 ------------------------------------------------
-- 원장 문제 12번 — "오늘 몇 명이 신청했는지 눈으로 셈. 자주 틀림"

create index applications_created_at_idx on public.applications (created_at desc);
create index applications_cert_std_idx   on public.applications (certificate_std);


-- 3) 접근 권한 (RLS) --------------------------------------------
-- Supabase는 기본이 잠김 상태입니다. 필요한 문만 엽니다.

alter table public.applications enable row level security;

-- 넣는 문: 접수 화면에서 신청서 제출
create policy "접수 화면: 신청서 제출 허용"
  on public.applications
  for insert to anon
  with check (true);

-- 보는 문: 어드민 화면에서 접수 내역 조회
create policy "어드민 화면: 접수 내역 조회 허용"
  on public.applications
  for select to anon
  using (true);

-- update / delete 정책은 일부러 만들지 않습니다.
-- 정책이 없으면 anon은 수정도 삭제도 할 수 없습니다.
-- 원장 문제 10번 — "두 직원이 같은 파일을 열면 나중에 저장한 쪽이 앞의 것을
-- 덮어씀. 이번 달에 두 건이 사라졌습니다" → 구조적으로 불가능해집니다.
-- 원본 보존 원칙과도 맞습니다: 한 번 들어온 접수는 아무도 못 고칩니다.


-- 4) 확인 -------------------------------------------------------

-- 컬럼 확인 (원본 5 + 자동 2 + 판정 3 = 10개)
select column_name, data_type, is_nullable, is_generated
from information_schema.columns
where table_name = 'applications'
order by ordinal_position;

-- 정책 2개 확인
select policyname, cmd from pg_policies where tablename = 'applications';


-- =============================================================
-- 되돌리기 (필요할 때만)
--   drop table public.applications;   -- 데이터도 함께 사라집니다
-- =============================================================
