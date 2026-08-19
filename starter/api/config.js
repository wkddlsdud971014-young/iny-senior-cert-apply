// =============================================================
// Supabase 접속 정보를 내려 주는 함수 (Vercel Serverless Function)
//
// 왜 필요한가
//   우리 사이트는 순수 HTML 이라 브라우저가 환경변수를 읽지 못합니다.
//   그래서 서버가 환경변수를 읽어 자바스크립트 파일 모양으로 내려 줍니다.
//
// 어떻게 불리는가
//   화면은 그대로 <script src="config.js"> 를 부릅니다.
//   vercel.json 이 /config.js 요청을 이 함수로 넘겨 줍니다.
//   (내 컴퓨터에서 파일로 열 때는 config.js 파일이 그대로 쓰입니다)
//
// 주의
//   anon key 는 브라우저에 노출되는 공개용 키입니다.
//   환경변수에 넣어도 결국 보입니다. 보호는 Supabase RLS 가 합니다.
//   service_role 키는 절대 여기에 넣지 마십시오.
// =============================================================

export default function handler(req, res) {
  const url = process.env.SUPABASE_URL || "";
  const key = process.env.SUPABASE_ANON_KEY || "";

  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=60");

  if (!url || !key) {
    res.status(500).send(
      'console.error("Vercel 환경변수 SUPABASE_URL / SUPABASE_ANON_KEY 가 설정되지 않았습니다.");\n' +
      'const SUPABASE_URL = "";\nconst SUPABASE_ANON_KEY = "";\n'
    );
    return;
  }

  res.status(200).send(
    `const SUPABASE_URL = ${JSON.stringify(url)};\n` +
    `const SUPABASE_ANON_KEY = ${JSON.stringify(key)};\n`
  );
}
