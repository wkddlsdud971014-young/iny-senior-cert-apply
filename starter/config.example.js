// =============================================================
// Supabase 연결 정보
//
// anon key는 브라우저에 그대로 노출되는 공개용 키입니다.
// 숨길 수 없는 키라서 RLS 정책으로 보호합니다 (supabase.sql 3절).
//
// 🚫 service_role / secret 키는 절대 이 파일에 넣지 마십시오.
//    저장소가 Public이라 올라가면 DB가 통째로 열립니다.
//
// [내 컴퓨터에서 열 때]
//   이 파일을 config.js 로 복사한 뒤 값을 넣으십시오.
//     cp config.example.js config.js
//   config.js 는 .gitignore 에 걸려 있어 GitHub 에 올라가지 않습니다.
//
// [Vercel 에 올라갔을 때]
//   config.js 파일이 없으므로 vercel.json 규칙에 따라
//   api/config.js 함수가 환경변수를 읽어 대신 내려 줍니다.
// =============================================================

const SUPABASE_URL = "여기에_Project_URL";

const SUPABASE_ANON_KEY = "여기에_anon_key";
