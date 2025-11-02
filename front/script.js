/********************
 * Campus Café Finder
 * - Kakao Places API로 카페 검색
 * - 고급 알고리즘으로 점수 계산 (목적/분위기/인원/거리)
 * - 백엔드 AI 재랭킹 연동
 ********************/

/* 1) 국민대 좌표 */
const KMU = { lat: 37.610144, lng: 126.997708 };

// 검색 중심점 (동쪽으로 이동: 국민대와 성신여대/길음역 사이)
const SEARCH_CENTER = { lat: 37.607, lng: 127.012 };

/* 2) 상수 정의 */
// 정릉 지역 실제 프랜차이즈 목록 (교내 제외, 정릉 주변 실제 존재하는 프랜차이즈)
const FRANCHISES = [
  "스타벅스","투썸","이디야","메가커피","빽다방","할리스",
  "커피빈","컴포즈","더벤티","드롭탑","탐앤탐스"
];
const SMALL_HINTS = ["테이크아웃","작은","소형","스탠딩","갤러리","디저트"];

const PURPOSE_KW = {
  date: {
    plus:  ["디저트","베이커리","브런치","감성","무드","포토","뷰","인테리어","예쁜","루프탑","창가","느좋"],
    minus: ["스터디","과제","회의","테이크아웃","조용",'포장']
  },
  study: {
    plus:  ["스터디","그룹","모임","단체석","토론","넓은","대형","프랜차이즈","좌석","적당"],
    minus: ["1인","개인","사일런스","독서","완전","조용"]
  },
  assignment: {
    plus:  ["조용","한적","독서","집중","1인","개인","사일런스","노이즈","콘센트","와이파이","노트북"],
    minus: ["스터디","그룹","모임","단체","토론","시끄러","활발","대화","수다"]
  }
};

/* 3) DOM 요소 */
const $ = s => document.querySelector(s);
const purposeEl = $("#purpose");
const radiusEl = $("#radius");
const peopleEl = $("#peopleCount");
const searchBtn = $("#searchBtn");
const listEl = $("#cafeList");
const countEl = $("#cafeCount");

/* 4) 유틸 함수 */
function toRad(d) { return d * Math.PI / 180; }
function hav(a, b) {
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const aa = s1 * s1 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * s2 * s2;
  return 2 * R * Math.asin(Math.sqrt(aa));
}
const kmOrM = m => m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
const kakaoURL = (n, a) => `https://map.kakao.com/?q=${encodeURIComponent(`${n} ${a}`)}`;
const naverURL = (n, a) => `https://map.naver.com/p/search/${encodeURIComponent(`${n} ${a}`)}`;

/* 5) 텍스트 처리 헬퍼 */
function bagify(s = "") { return (s || "").toLowerCase(); }
function _baseText(cafe) {
  return bagify(`${cafe.name || cafe.place_name || ""} ${cafe.category || cafe.category_name || ""} ${cafe.addr || cafe.road_address_name || cafe.address_name || ""}`);
}
function isFranchise(text = "") {
  const lowerText = text.toLowerCase();
  // "플레이스엔" 제외 (개별 카페로 처리)
  if (lowerText.includes("플레이스엔")) {
    return false;
  }
  return FRANCHISES.some(b => lowerText.includes(b.toLowerCase()));
}
function hasSmallHints(text = "") { return SMALL_HINTS.some(k => text.includes(k.toLowerCase())); }

// 교내 카페 판단 (정릉로 77 주소 또는 매우 가까운 거리, 단 교내 프랜차이즈는 제외)
function isOnCampus(cafe) {
  if (!cafe || !cafe.lat || !cafe.lng) return false;
  
  // 교내 프랜차이즈는 제외 (교내에 있어도 프랜차이즈로 간주하지 않음)
  const txt = _baseText(cafe);
  if (isFranchise(txt)) return false;
  
  const name = (cafe.name || "").toLowerCase();
  const addr = (cafe.addr || "").toLowerCase();
  
  // 주소/이름 기반 판단
  if (name.includes("국민대") || 
      addr.includes("국민대") ||
      addr.includes("정릉로 77") || 
      addr.includes("정릉로77") ||
      addr.includes("정릉로77번")) {
    return true;
  }
  
  // 거리 기반 판단
  const dist = hav(KMU, { lat: cafe.lat, lng: cafe.lng });
  return dist < 50; // 50m 이내는 교내로 간주
}

/* 6) 목적 점수(로그 완곡) */
function purposeScoreAdv(cafe, purpose = "study") {
  const cfg = PURPOSE_KW[purpose] || PURPOSE_KW.study;
  const text = _baseText(cafe);
  const plus = (cfg.plus || []).reduce((a, k) => a + (text.includes(k.toLowerCase()) ? 1 : 0), 0);
  const minus = (cfg.minus || []).reduce((a, k) => a + (text.includes(k.toLowerCase()) ? 1 : 0), 0);
  const raw = Math.log1p(plus) - 0.7 * Math.log1p(minus); // 감점은 완곡
  return Math.max(0, Math.min(1, 0.6 + raw * 0.6)); // 0~1
}

/* 8) 인원 보정(프랜차이즈 가점 강화/소형 암시 감점) */
function peopleFactor(people, cafe, purpose) {
  const name = _baseText(cafe);
  const isF = isFranchise(name);
  const isS = hasSmallHints(name);
  let factor = 1.0;

  if (people >= 5) { // 다인원
    if (isF) factor += 0.25; // 프랜차이즈 큰 가점 (기존 0.10 → 0.25)
    if (isS) factor -= 0.20; // 소형 암시 강한 감점 (기존 0.15 → 0.20)
  } else if (people <= 2) { // 소인원
    if (purpose === "date") {
      if (name.includes("디저트") || name.includes("브런치") || name.includes("감성")) factor += 0.08;
      if (isF) factor -= 0.05; // 데이트시 대형 체인 소폭 감점
    } else {
      // 스터디/과제 시 프랜차이즈 소폭 가점
      if (isF) factor += 0.05;
    }
  } else { // 3~4명
    if (isF) factor += 0.15; // 프랜차이즈 가점 강화 (기존 0.03 → 0.15)
  }
  return Math.max(0.6, Math.min(1.35, factor)); // 범위 확대: 0.6~1.35 (기존 0.7~1.15)
}

/* 9) 카테고리 소량 보너스 */
function categoryBonus(cafe, purpose) {
  let s = 0;
  const code = (cafe.category_group_code || cafe.category_code || "");
  if (code.includes("CE7")) s += 0.4; // 카페 카테고리 보너스
  const txt = _baseText(cafe);
  if (purpose === "date" && (txt.includes("디저트") || txt.includes("베이커리") || txt.includes("브런치"))) s += 0.3;
  return Math.max(0, Math.min(1, s)) * 0.10; // 0~0.1
}

/* 9-1) 목적별 드라마틱 보정 (스터디: 교외 프랜차이즈 / 과제: 교내 카페) */
function purposeDramaticFactor(cafe, purpose) {
  const txt = _baseText(cafe);
  const isF = isFranchise(txt);
  const isS = hasSmallHints(txt);
  const isCampus = isOnCampus(cafe);
  const isOffCampus = !isCampus; // 교외
  let factor = 1.0;

  if (purpose === "study") {
    // 스터디: 학교 외부 프랜차이즈에 매우 큰 가점
    const bigKeywords = ["대형", "넓은", "단체석", "스터디룸", "라운지"];
    const bigMatches = bigKeywords.filter(k => txt.includes(k.toLowerCase())).length;
    
    // 교외 프랜차이즈: 매우 큰 가점
    if (isOffCampus && isF) {
      factor += 0.80; // 교외 프랜차이즈 큰 가점 (기존 0.40 → 0.80)
    } else if (isF) {
      factor += 0.30; // 교내 프랜차이즈는 작은 가점
    }
    
    // 교외 프랜차이즈 + 대형은 더 큰 가점
    if (isOffCampus && isF && bigMatches > 0) factor += 0.25;
    
    if (bigMatches > 0) factor += 0.15 * Math.min(bigMatches / 2, 1);
    if (isS) factor -= 0.30; // 작은 곳 강한 감점
    
    // 교내 카페는 감점
    if (isCampus && !isF) factor -= 0.20;
    
  } else if (purpose === "assignment") {
    // 과제: 교내 카페에 매우 큰 가점
    const quietKeywords = ["조용", "한적", "사일런스", "독서", "집중", "1인", "개인"];
    const quietMatches = quietKeywords.filter(k => txt.includes(k.toLowerCase())).length;
    
    // 교내 카페: 매우 큰 가점
    if (isCampus) {
      factor += 0.70; // 교내 카페 큰 가점
      if (quietMatches > 0) factor += 0.25; // 교내 + 조용한 곳은 추가 가점
    } else {
      // 교외는 기본 점수만
      if (isS) factor += 0.20;
      if (quietMatches > 0) factor += 0.15 * Math.min(quietMatches / 3, 1);
    }
    
    // 교외 프랜차이즈는 강한 감점
    if (isOffCampus && isF) factor -= 0.35;
    
    // 시끄러운 곳 감점
    const noisyKeywords = ["북적", "바쁜", "혼잡", "시끄러", "활발", "인기"];
    const noisyMatches = noisyKeywords.filter(k => txt.includes(k.toLowerCase())).length;
    if (noisyMatches > 0) factor -= 0.25 * Math.min(noisyMatches / 2, 1);
  }
  
  // date는 기본값 유지
  return Math.max(0.3, Math.min(2.0, factor)); // 범위 확대: 과제는 최대 2.0까지, 스터디도 최대 2.0까지
}

/* 10) 최종 점수 계산 */
function calculateScore(cafe, { purpose, radius, people }) {
  // 목적별 가중치 (편의시설 제거, 거리 비율 약간 감소)
  function getWeightsByPurpose(p) {
    if (p === "date") return { purpose: 0.70, distance: 0.30 };
    if (p === "assignment") return { purpose: 0.75, distance: 0.25 };
    return /* study */ { purpose: 0.70, distance: 0.30 };
  }
  const W = getWeightsByPurpose(purpose);

  const distance_m = hav(KMU, { lat: cafe.lat, lng: cafe.lng });
  
  // 길음 쪽(동쪽) 편향: 경도가 큰 카페에 거리 보정 (최대 20% 거리 감소 효과)
  const isEast = cafe.lng > KMU.lng; // 동쪽(길음)인지 확인
  const distanceCorrected = isEast ? distance_m * 0.8 : distance_m; // 동쪽은 거리 20% 감소 효과
  
  const sPurpose = purposeScoreAdv(cafe, purpose);
  const sDist = Math.max(0, 1 - (distanceCorrected / Math.max(1, radius)));
  const sCat = categoryBonus(cafe, purpose);

  let base = W.purpose * sPurpose + W.distance * sDist + sCat; // 0~1.1
  base = Math.max(0, Math.min(1, base)); // 0~1로 고정

  const pf = peopleFactor(people, cafe, purpose); // 0.6~1.35 (프랜차이즈 가점 강화)
  const pdf = purposeDramaticFactor(cafe, purpose); // 목적별 드라마틱 보정 (0.3~2.0)
  const final100 = Math.min(100, Math.round(base * pf * pdf * 1000) / 10); // 0~100 소수1자리 (100% 초과 방지)

  return { score01: base, score100: final100, distance_m };
}

/* 11) 리스트용 아이템 구성 & 정렬 */
function compute(ctx, cafes) {
  const { purpose, radius, people } = ctx;
  return cafes
    .map(c => {
      const { score01, score100, distance_m } = calculateScore(c, { purpose, radius, people });
      const reasons = [];
      if (score01 > 0.55) reasons.push("조건 적합");
      if (distance_m <= radius * 0.5) reasons.push("가까운 거리");
      const reason = reasons.slice(0, 2).join(" · ") || "균형적 적합";

      return {
        ...c,
        distance_m,
        distStr: kmOrM(distance_m),
        score: score01, // 내부 0~1
        viewScore: score100, // 표시 0~100 (퍼센트 적합률)
        reason,
        kakaoUrl: c.placeUrl || kakaoURL(c.name || c.place_name, c.addr || c.road_address_name || c.address_name),
        naverUrl: naverURL(c.name || c.place_name, c.addr || c.road_address_name || c.address_name),
      };
    })
    .sort((a, b) => b.viewScore - a.viewScore || a.distance_m - b.distance_m); // 퍼센트 적합률 순서대로 정렬
}

/* 12) Kakao Places API */
function loadCafesFromKakao(radiusMeters = 800) {
  return new Promise((resolve, reject) => {
    if (!(window.kakao && kakao.maps && kakao.maps.services)) {
      return reject(new Error("Kakao SDK not loaded or unauthorized domain"));
    }
    kakao.maps.load(() => {
      const ps = new kakao.maps.services.Places();
      // 반경에 따라 검색 중심점 결정: 1km 이하는 국민대, 3km 이상은 동쪽
      const searchCenter = radiusMeters <= 1000 ? KMU : SEARCH_CENTER;
      const center = new kakao.maps.LatLng(searchCenter.lat, searchCenter.lng);
      const options = { location: center, radius: radiusMeters, sort: kakao.maps.services.SortBy.DISTANCE };
      const all = [];
      let page = 1;

      const onPage = (data, status, pagination) => {
        if (status === kakao.maps.services.Status.OK) {
          all.push(...data);
          if (pagination && page < pagination.last) {
            page += 1;
            pagination.gotoPage(page);
          } else {
            resolve(all.map(r => ({
              id: r.id,
              name: r.place_name,
              addr: r.road_address_name || r.address_name || "",
              lat: Number(r.y),
              lng: Number(r.x),
              category: r.category_name || "",
              placeUrl: r.place_url,
              phone: r.phone || "",
            })));
          }
        } else if (status === kakao.maps.services.Status.ZERO_RESULT) {
          resolve([]);
        } else {
          reject(new Error("Kakao search failed: " + status));
        }
      };
      ps.categorySearch("CE7", onPage, options);
    });
  });
}

/* 13) 렌더링 */
function renderList(items) {
  listEl.innerHTML = "";
  countEl.textContent = `${items.length}`;
  items.forEach((c, idx) => {
    const el = document.createElement("div");
    el.className = "cafe-item";
    el.innerHTML = `
      <div class="cafe-name">${idx + 1}. ${c.name} <span class="cafe-score">${Math.round(c.viewScore || c.score * 100)}%</span></div>
      <div class="cafe-info"><span>📍 ${c.addr}</span><span>${c.distStr}</span></div>
      <div class="cafe-reason">💡 ${c.reason}</div>
      <div class="cafe-links">
        <a href="${c.kakaoUrl}" target="_blank">카카오맵</a>
        <a href="${c.naverUrl}" target="_blank">네이버지도</a>
      </div>
    `;
    el.addEventListener("click", () => centerMap(c.lat, c.lng));
    listEl.appendChild(el);
  });
  if (!items.length) {
    listEl.innerHTML = `
      <div class="empty-state">
        <p>😔 선택한 반경 내에 카페를 찾을 수 없습니다.</p>
        <p class="sub-text">반경을 늘려서 다시 검색해보세요.</p>
      </div>`;
    countEl.textContent = "0";
  }
}

/* 14) 지도 */
let map, markers = [];
function initMap() {
  if (!(window.kakao && kakao.maps)) return;
  kakao.maps.load(() => {
    const container = document.getElementById("map");
    if (!container) return;
    map = new kakao.maps.Map(container, {
      center: new kakao.maps.LatLng(KMU.lat, KMU.lng),
      level: 4
    });
    new kakao.maps.Marker({
      map,
      position: new kakao.maps.LatLng(KMU.lat, KMU.lng),
      title: "국민대학교"
    });
  });
}
function clearMarkers() {
  markers.forEach(m => m.setMap(null));
  markers = [];
}
function addMarker(lat, lng, title) {
  if (!map || !(window.kakao && kakao.maps)) return;
  const m = new kakao.maps.Marker({
    map,
    position: new kakao.maps.LatLng(lat, lng),
    title
  });
  markers.push(m);
}
function centerMap(lat, lng) {
  if (!map || !(window.kakao && kakao.maps)) return;
  map.setCenter(new kakao.maps.LatLng(lat, lng));
}

/* 15) 캐시 & 재계산 */
let cached = { radius: 0, cafes: [] };
let currentContext = null; // 현재 검색 조건 저장
let requestId = 0; // 요청 ID (AI 재랭킹 결과 검증용)

function renderByContext({ purpose, radius, people }) {
  // 현재 검색 조건 저장 및 요청 ID 증가
  currentContext = { purpose, radius, people };
  requestId += 1;
  const thisRequestId = requestId; // 이번 요청의 ID
  
  // 반경에 따라 필터 기준 다르게: 1km 이하는 국민대 기준, 3km 이상은 동쪽 기준
  const filterCenter = radius <= 1000 ? KMU : SEARCH_CENTER;
  
  const within = cached.cafes.filter(c => {
    const dist = hav(filterCenter, { lat: c.lat, lng: c.lng });
    const isEast = c.lng > KMU.lng; // 동쪽(길음)인지 확인
    
    // 데이트 항목에서만 학교 주소 카페 제외
    if (purpose === "date") {
      const name = (c.name || "").toLowerCase();
      const addr = (c.addr || "").toLowerCase();
      const isOnCampus = name.includes("국민대") || 
                         addr.includes("국민대") ||
                         addr.includes("정릉로 77") || 
                         addr.includes("정릉로77") ||
                         addr.includes("정릉로77번");
      if (isOnCampus) return false;
    }
    
    // 반경 필터: 3km 이상일 때는 동쪽 카페 확장 허용
    if (radius >= 3000 && isEast) {
      return dist <= radius * 1.25; // 동쪽은 반경 25% 확장
    }
    
    return dist <= radius;
  });
  const ranked = compute({ purpose, radius, people }, within);
  renderList(ranked);
  clearMarkers();
  ranked.forEach(c => addMarker(c.lat, c.lng, c.name));
  if (ranked.length) centerMap(ranked[0].lat, ranked[0].lng);

  // 백엔드 AI 재랭킹 시도 (실패해도 무시)
  aiRerankIfPossible({ purpose, peopleCount: people }, ranked, thisRequestId).catch(() => {});
}

async function aiRerankIfPossible({ purpose, peopleCount }, items, requestIdForCheck) {
  try {
    const body = {
      purpose,
      peopleCount,
      cafes: items.map(c => ({
        name: c.name,
        addr: c.addr,
        url: c.kakaoUrl || c.placeUrl || kakaoURL(c.name, c.addr),
        distance_m: c.distance_m
      }))
    };
    const backend = window.BACKEND_ORIGIN || 'http://localhost:5050';
    const res = await fetch(`${backend}/rerank/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) return;
    const data = await res.json();
    if (!Array.isArray(data.order)) return;
    
    // 결과를 받기 전에 검색 조건이 변경되었거나 새로운 요청이 들어왔는지 확인
    if (!currentContext || 
        currentContext.purpose !== purpose || 
        currentContext.people !== peopleCount ||
        requestId !== requestIdForCheck) { // 요청 ID가 다르면 무시 (새로운 검색이 실행됨)
      return; // 조건이 변경되었거나 새로운 요청이 들어왔으면 결과 무시
    }
    
    const reordered = data.order.map(i => items[i]).filter(Boolean);
    if (!reordered.length) return;
    renderList(reordered);
    clearMarkers();
    reordered.forEach(c => addMarker(c.lat, c.lng, c.name));
    centerMap(reordered[0].lat, reordered[0].lng);
  } catch (_) {
    // 백엔드 미동작/키 미설정 시 조용히 무시
  }
}

/* 16) 이벤트: 조건 변경 시 자동 재계산 비활성화 (검색 버튼 클릭 시에만 업데이트) */
// 드롭다운 변경 시 자동으로 재계산하지 않음 - 검색 버튼 클릭 시에만 목록 업데이트

/* 17) 시작: 검색 버튼 */
window.addEventListener("DOMContentLoaded", () => {
  initMap();
  searchBtn?.addEventListener("click", async () => {
    const purpose = purposeEl.value;
    const radius = Number(radiusEl.value);
    const people = Number(peopleEl.value || 1);
    try {
      // 반경을 키울 때만 재호출 (데이터 늘림). 같거나 줄이면 캐시 재사용.
      if (!cached.cafes.length || radius > cached.radius) {
        const cafes = await loadCafesFromKakao(radius);
        cached = { radius, cafes };
      }
      renderByContext({ purpose, radius, people });
    } catch (err) {
      console.error(err);
      listEl.innerHTML = `
        <div class="empty-state">
          <p>❌ 카카오 장소 검색에 실패했습니다.</p>
          <p class="sub-text">도메인 등록/JS 키/네트워크 상태를 확인한 뒤 다시 시도하세요.</p>
        </div>`;
      countEl.textContent = "0";
      alert("카카오 장소 검색에 실패했어요.");
    }
  });
});
