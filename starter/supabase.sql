-- =============================================================
-- 시니어 자격증 접수 서비스 — Supabase 초기 설정
--
-- 실행 위치: Supabase 대시보드 > SQL Editor > New query > 붙여넣고 Run
-- 실행 횟수: 1회 (이미 만들었다면 다시 실행하면 오류가 납니다)
-- =============================================================


-- 1) 접수 테이블 ------------------------------------------------
-- 컬럼은 발주처가 쓰던 접수대장.docx 칸을 그대로 옮긴 것입니다.
--   "이 표의 칸이 곧 저희가 받아야 하는 정보입니다" (01_사업현황_발주서.md 79줄)

create table public.applications (
  -- 접수번호: 사람이 안 적어도 DB가 1, 2, 3... 자동 부여
  id          bigint generated always as identity primary key,

  -- 접수일: 제출 시각 자동 기록
  -- 원장 문제 14번 — 8/1, 8월 3일, 2026-08-12 표기가 섞여 있었음
  created_at  timestamptz not null default now(),

  -- 이름
  name        text not null,

  -- 연락처: null 허용
  -- 원장 4행이 실제로 비어 있고 비고에 "연락처 못 받음"이라 적혀 있음.
  -- 필수로 걸면 그 신청이 아예 못 들어옴
  phone       text,

  -- 신청 자격증: 8종 외의 값은 DB가 거부
  -- 원장 문제 15번 — 한식 / 한식조리 / 한식조리기능사가 같은 것이었음
  certificate text not null,

  -- 접수경로: 이 서비스로 들어온 건 전부 온라인
  -- 원장 문제에서 전화 / 전화문의 표기가 갈렸던 칸
  channel     text not null default '온라인',

  -- 비고
  note        text,

  constraint applications_certificate_check check (certificate in (
    '한식조리기능사',
    '지게차운전기능사',
    '굴착기운전기능사',
    '전기기능사',
    '손해평가사',
    '공인중개사',
    '요양보호사',
    '위생사'
  ))
);

comment on table public.applications is '자격증 필기 접수 신청 (접수대장.docx 대체)';


-- 2) 조회 인덱스 ------------------------------------------------
-- 원장 문제 12번 — "오늘 몇 명이 신청했는지 눈으로 셈. 자주 틀림"
-- 어드민의 주 작업이 날짜순 조회라 인덱스를 걸어 둡니다.

create index applications_created_at_idx
  on public.applications (created_at desc);


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


-- 4) 확인 -------------------------------------------------------
-- 아래를 실행해서 결과가 나오면 정상입니다.

-- 컬럼 7개 확인
select column_name, data_type, is_nullable
from information_schema.columns
where table_name = 'applications'
order by ordinal_position;

-- 정책 2개 확인
select policyname, cmd from pg_policies where tablename = 'applications';


-- =============================================================
-- 되돌리기 (필요할 때만)
--
--   자격증 제약만 빼기:
--     alter table public.applications
--       drop constraint applications_certificate_check;
--
--   테이블 통째로 지우기 (데이터도 사라집니다):
--     drop table public.applications;
-- =============================================================
