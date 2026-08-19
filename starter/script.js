// =============================================================
// 접수 화면 동작
//
// 원칙: 사용자가 넣은 값을 고치지 않고 그대로 저장합니다.
//       연락처의 하이픈을 지우거나 이름의 공백을 다듬지 않습니다.
//       정리된 값이 필요하면 DB가 파생 컬럼에서 따로 계산합니다.
// =============================================================


// ----- 자격증 8종 (02_안내규정.md 1절, 2절, 3절) -----
// fee 가 null 인 것은 발주처가 "확인 못 함"이라고 적은 4종입니다.
// 짐작해서 숫자를 넣지 않습니다.

const CERTIFICATES = [
  { name: "한식조리기능사",   org: "두두자격검정원 · 두두넷",        method: "상시 접수", fee: "14,500원", note: "" },
  { name: "지게차운전기능사", org: "두두자격검정원 · 두두넷",        method: "상시 접수", fee: "14,500원", note: "" },
  { name: "굴착기운전기능사", org: "두두자격검정원 · 두두넷",        method: "상시 접수", fee: "14,500원", note: "" },
  { name: "전기기능사",       org: "두두자격검정원 · 두두넷",        method: "정기 접수 (연 4회)", fee: "14,500원",
    note: "제4회 필기 접수: 8월 24일 ~ 8월 27일" },
  { name: "요양보호사",       org: "두두보건시험원 · 상시시험 사이트", method: "상시 접수", fee: null,
    note: "시험일 7일 전까지 접수합니다" },
  { name: "위생사",           org: "두두보건시험원 · 대표 사이트",    method: "별도",      fee: null,
    note: "시험 일정을 확인하지 못했습니다" },
  { name: "손해평가사",       org: "두두자격검정원 · 전용 사이트",    method: "1차 · 2차 (연 1회)", fee: null,
    note: "올해 1차 접수는 끝났습니다" },
  { name: "공인중개사",       org: "두두자격검정원 · 전용 사이트",    method: "1차 · 2차 (연 1회)", fee: null,
    note: "올해 1차 접수는 끝났습니다" }
];


// ----- 화면 요소 -----
const certList = document.getElementById("cert-list");
const form     = document.getElementById("apply-form");
const nameBox  = document.getElementById("name");
const phoneBox = document.getElementById("phone");
const noteBox  = document.getElementById("note");
const msgBox   = document.getElementById("msg");
const sendBtn  = document.getElementById("send-btn");
const doneBox  = document.getElementById("done");

let picked = null;   // 고른 자격증 이름


// ----- 1. 자격증 카드 그리기 -----
CERTIFICATES.forEach(function (cert) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "card";
  card.dataset.name = cert.name;

  const fee = cert.fee
    ? "필기 응시료 " + cert.fee
    : "필기 응시료 확인 필요";

  card.innerHTML =
    '<span class="cert-name"></span>' +
    '<span class="cert-info"></span>' +
    '<span class="cert-info method"></span>' +
    '<span class="cert-fee"></span>' +
    (cert.note ? '<span class="cert-note"></span>' : "") +
    '<span class="picked">✔ 선택됨</span>';

  card.querySelector(".cert-name").textContent = cert.name;
  card.querySelector(".cert-info").textContent = cert.org;
  card.querySelector(".method").textContent    = cert.method;
  card.querySelector(".cert-fee").textContent  = fee;
  if (cert.note) card.querySelector(".cert-note").textContent = cert.note;

  card.addEventListener("click", function () {
    document.querySelectorAll(".card").forEach(function (c) { c.classList.remove("on"); });
    card.classList.add("on");
    picked = cert.name;
    clearMessage();
  });

  certList.appendChild(card);
});


// ----- 2. 안내 문구 -----
function showMessage(text) {
  msgBox.textContent = text;
  msgBox.className = "warn";
}
function clearMessage() {
  msgBox.textContent = "";
  msgBox.className = "";
}


// ----- 3. 신청서 보내기 -----
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

form.addEventListener("submit", async function (event) {
  event.preventDefault();
  clearMessage();

  // 화면에서 안내만 합니다. DB에는 이런 제약을 걸지 않았습니다.
  if (!picked) {
    showMessage("자격증을 하나 골라 주십시오.");
    certList.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  if (nameBox.value.trim() === "") {
    showMessage("이름을 넣어 주십시오.");
    nameBox.focus();
    return;
  }

  sendBtn.disabled = true;
  sendBtn.textContent = "보내는 중입니다...";

  // 입력한 값을 그대로 저장합니다. 다듬지 않습니다.
  const row = {
    name:        nameBox.value,
    phone:       phoneBox.value,
    note:        noteBox.value,
    certificate: picked,      // 원본
    certificate_std: picked,  // 판정 (카드에서 고른 값이라 표준명과 같음)
    channel:     "온라인"
  };

  const { data, error } = await db
    .from("applications")
    .insert(row)
    .select("id, created_at")
    .single();

  sendBtn.disabled = false;
  sendBtn.textContent = "신청서 보내기";

  if (error) {
    showMessage("접수가 되지 않았습니다. 잠시 뒤에 다시 눌러 주십시오. (" + error.message + ")");
    return;
  }

  showDone(data, row);
});


// ----- 4. 접수 완료 화면 -----
function showDone(saved, row) {
  document.getElementById("done-no").textContent   = saved.id;
  document.getElementById("done-cert").textContent = row.certificate;
  document.getElementById("done-name").textContent = row.name;

  const t = new Date(saved.created_at);
  document.getElementById("done-at").textContent =
    t.getFullYear() + "년 " + (t.getMonth() + 1) + "월 " + t.getDate() + "일 " +
    String(t.getHours()).padStart(2, "0") + "시 " +
    String(t.getMinutes()).padStart(2, "0") + "분";

  form.hidden = true;
  doneBox.hidden = false;
  doneBox.scrollIntoView({ behavior: "smooth", block: "start" });
}
