# Campus Café Finder

국민대학교 주변 카페를 **인원·목적·반경** 조건에 맞춰 추천하는 웹 애플리케이션입니다.

## 구현 기능
- Kakao Places API(카테고리 **CE7**)로 실제 카페 데이터 조회
- **목적/거리/인원/교내 여부/프랜차이즈** 가중치 기반 랭킹 알고리즘
- 지도 + 추천 리스트 UI
- **로딩 Skeleton / Empty 상태 / 오류 Toast** 지원

## 🛠 기술 스택
- **Frontend**: HTML, CSS, JavaScript  
- **API**: Kakao Maps JavaScript SDK (services)  
- **Backend**: Node.js (Express), CORS, dotenv  
- **Tools**: Cursor, GitHub, Python http.server

## 🚀 실행 방법

이 프로젝트는 **백엔드(Express)** 와 **프런트엔드(정적 웹)** 두 부분으로 구성되어 있습니다.

```bash
# 1) 백엔드 서버 실행
cd backend
npm install
npm run dev        # http://localhost:5050 에서 실행됨
# 헬스체크
curl -s http://localhost:5050/health

# 2) 프런트엔드 실행
# 루트 폴더 (index.html이 있는 곳)로 이동 후
python3 -m http.server 8000
# 또는 Node 사용 시
# npx http-server -p 8000

# 3) 접속
# 프런트엔드: http://localhost:8000
# 백엔드: http://localhost:5050
```



