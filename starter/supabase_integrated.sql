-- =============================================================
-- 통합 접수 내역 테이블
--
-- data/ 의 CSV 3종을 합친 integrate/통합_접수_1000.csv 를 담습니다.
-- 실행 위치: Supabase 대시보드 > SQL Editor > New query > Run
--
-- [설계]
--   1) 모든 칸을 text 로 둡니다.
--      CSV의 빈 칸(회차·차수 등)이 숫자 칸으로 들어가면 가져오기가 실패합니다.
--      "없는 것"과 "0"은 다르므로 빈 칸 그대로 받습니다.
--   2) 칸 이름은 CSV 머리글과 똑같이 한글로 둡니다.
--      이름이 다르면 CSV 가져오기에서 칸을 하나하나 손으로 맞춰야 합니다.
--   3) 읽기만 허용합니다. 넣기/고치기/지우기 정책을 만들지 않습니다.
--      이 표는 원본을 옮겨 담은 것이라 아무도 고치면 안 됩니다.
-- =============================================================

create table public.integrated_applications (
  id bigint generated always as identity primary key,
  "출처" text,
  "접수번호" text,
  "성명" text,
  "생년월일" text,
  "생년월일_원본" text,
  "성별" text,
  "성별_원본" text,
  "연락처" text,
  "연락처_원본" text,
  "최종학력" text,
  "자격증" text,
  "시험지역" text,
  "시험장" text,
  "시험일자" text,
  "시험일자_원본" text,
  "교시_원본" text,
  "수수료" text,
  "감면유형" text,
  "감면유형_원본" text,
  "감면금액" text,
  "최종결제금액" text,
  "결제수단" text,
  "결제수단_원본" text,
  "결제상태" text,
  "결제상태_원본" text,
  "접수상태" text,
  "접수상태_원본" text,
  "접수일시" text,
  "접수일시_원본" text,
  "사용맥락" text,
  "등급" text,
  "시험유형" text,
  "회차" text,
  "시험구분" text,
  "응시자격유형" text,
  "시험연도" text,
  "차수" text,
  "1차합격여부" text,
  "시험과목" text,
  "교육기관" text,
  "교육수료번호" text,
  "교육수료일" text,
  "교육수료일_원본" text,
  "교육이수시간" text,
  "사진검증" text,
  "확인필요" text
);

comment on table public.integrated_applications is
  '두두넷 국가기술/전문 + 두두보건 접수 데이터를 합친 표 (1,000행). 원본 칸과 표준 칸을 함께 보관.';

-- 자주 보는 칸에 인덱스
create index integrated_source_idx on public.integrated_applications ("출처");
create index integrated_cert_idx   on public.integrated_applications ("자격증");
create index integrated_applied_idx on public.integrated_applications ("접수일시");

-- 읽기 전용
alter table public.integrated_applications enable row level security;

create policy "통합 내역 조회 허용"
  on public.integrated_applications
  for select to anon
  using (true);

-- insert / update / delete 정책은 만들지 않습니다.
-- 정책이 없으면 anon 은 넣지도 고치지도 지우지도 못합니다.


-- 확인 -------------------------------------------------------
select count(*) from public.integrated_applications;   -- 넣기 전에는 0
