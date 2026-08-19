// =============================================================
// Supabase 연결 정보
//
// anon key는 브라우저에 그대로 노출되는 공개용 키입니다.
// 숨길 수 없는 키라서 RLS 정책으로 보호합니다 (supabase.sql 3절).
//
// 🚫 service_role / secret 키는 절대 이 파일에 넣지 마십시오.
//    저장소가 Public이라 올라가면 DB가 통째로 열립니다.
//
// 접수 화면과 어드민 화면이 같은 키를 쓰므로 한 곳에만 둡니다.
// 키가 바뀌면 이 파일만 고치면 됩니다.
// =============================================================

const SUPABASE_URL = "https://ngxrwjgntbqdmnkzhqql.supabase.co";

const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5neHJ3amdudGJxZG1ua3pocXFsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwNzkzMjcsImV4cCI6MjEwMjY1NTMyN30.eyA2FPEk1lYmLbmlFDdLlX2BrdkoPD5UtZMfYj3oLog";
