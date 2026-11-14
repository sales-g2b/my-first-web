// Vercel 서버리스 함수: 공공데이터포털(apis.data.go.kr) 조달 API 중계
//  · 인증키는 Vercel 환경변수 G2B_API_KEY 에만 둡니다 (HTML/브라우저에 절대 넣지 않음)
//  · 브라우저는 /api/g2b?service=...&op=...&(조회조건) 로만 호출합니다
//  · 허용된 서비스만 중계하고, 같은 조회는 CDN 에 캐시해 일일 호출 한도를 아낍니다

const BASE = 'https://apis.data.go.kr/1230000';

const SERVICES = {
  CntrctInfoService: 'ao',
  PubPrcrmntStatInfoService: 'at',
  ShoppingMallPrdctInfoService: 'at',
  ThngListInfoService: 'ao'
};

const MAX_ROWS = 1000;
const CACHE_SECONDS = 600;

function normalizeKey(raw) {
  const k = String(raw || '').trim();
  if (!k) return '';
  try { return k.includes('%') ? decodeURIComponent(k) : k; } catch (e) { return k; }
}

function sendJson(res, status, obj, cache) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cache ? `public, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=60` : 'no-store');
  res.end(JSON.stringify(obj));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET 만 지원합니다.' });

  const key = normalizeKey(process.env.G2B_API_KEY);
  if (!key) return sendJson(res, 500, { ok: false, error: 'Vercel 환경변수 G2B_API_KEY 가 설정되지 않았습니다.' });

  const url = new URL(req.url, 'http://localhost');
  const service = url.searchParams.get('service') || '';
  const op = url.searchParams.get('op') || '';

  if (!Object.prototype.hasOwnProperty.call(SERVICES, service)) {
    return sendJson(res, 400, { ok: false, error: `허용되지 않은 service 입니다: ${service}`, allowed:
