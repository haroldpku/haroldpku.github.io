/**
 * 私有访问统计 Worker（Cloudflare Workers + KV）
 *
 * 部署前需要在 Cloudflare 后台完成两件事：
 *   1. 创建一个 KV namespace，并绑定到本 Worker，绑定变量名：STATS
 *   2. 在 Worker 的 Settings → Variables and Secrets 中添加 Secret：
 *      名称 STATS_KEY，值为一串只有你知道的随机字符串
 *      （它同时用作统计页访问密钥和 IP 哈希盐，不要写进代码、不要提交到仓库）
 *
 * 接口：
 *   POST /report   页面上报 {type:'pv'} 或 {type:'dwell', seconds:n}
 *   GET  /stats?key=<STATS_KEY>   私有统计页（密钥不对返回 404，避免被探测）
 */

// 东八区的当天日期
function cstDay(offsetDays = 0) {
    return new Date(Date.now() + 8 * 3600e3 - offsetDays * 86400e3).toISOString().slice(0, 10);
}

// 用 STATS_KEY 做盐对 IP 哈希：可按"独立访客"去重，又不落盘任何原始 IP
async function hashIp(env, ip, scope) {
    const data = new TextEncoder().encode(env.STATS_KEY + '|' + scope + '|' + ip);
    const buf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function incr(env, key, by = 1) {
    const cur = parseInt(await env.STATS.get(key) || '0', 10);
    await env.STATS.put(key, String(cur + by));
}

function fmtDuration(sec) {
    if (!sec) return '—';
    const m = Math.floor(sec / 60), s = sec % 60;
    return m ? `${m}分${s}秒` : `${s}秒`;
}

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: CORS });
        }

        // ---- 数据上报 ----
        if (url.pathname === '/report' && request.method === 'POST') {
            let body = {};
            try { body = await request.json(); } catch (e) { /* sendBeacon 容错 */ }

            const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
            const day = cstDay();

            if (body.type === 'pv') {
                await incr(env, 'pv:total');
                await incr(env, 'pv:' + day);

                // 当日独立访客（哈希按天轮换，历史不可关联）
                const hd = await hashIp(env, ip, day);
                if (!(await env.STATS.get('ip:' + day + ':' + hd))) {
                    await env.STATS.put('ip:' + day + ':' + hd, '1', { expirationTtl: 40 * 86400 });
                    await incr(env, 'uv:' + day);
                }
                // 累计独立访客
                const ha = await hashIp(env, ip, 'all');
                if (!(await env.STATS.get('ipall:' + ha))) {
                    await env.STATS.put('ipall:' + ha, '1');
                    await incr(env, 'uv:total');
                }
            } else if (body.type === 'dwell') {
                // 单次上报截断到 2 小时，防异常值污染平均值
                const s = Math.min(Math.max(parseInt(body.seconds, 10) || 0, 0), 7200);
                if (s > 0) {
                    await incr(env, 'dwell:sec', s);
                    await incr(env, 'dwell:n');
                    await incr(env, 'dwell:' + day + ':sec', s);
                    await incr(env, 'dwell:' + day + ':n');
                }
            }
            return new Response('ok', { headers: CORS });
        }

        // ---- 私有统计页 ----
        if (url.pathname === '/stats') {
            if (url.searchParams.get('key') !== env.STATS_KEY) {
                return new Response('Not found', { status: 404 });
            }

            const [tpv, tuv, tsec, tn] = await Promise.all([
                env.STATS.get('pv:total'), env.STATS.get('uv:total'),
                env.STATS.get('dwell:sec'), env.STATS.get('dwell:n'),
            ]);
            const totalAvg = tn ? Math.round((parseInt(tsec, 10) || 0) / parseInt(tn, 10)) : 0;

            const rows = [];
            for (let i = 0; i < 14; i++) {
                const d = cstDay(i);
                const [pv, uv, dsec, dn] = await Promise.all([
                    env.STATS.get('pv:' + d), env.STATS.get('uv:' + d),
                    env.STATS.get('dwell:' + d + ':sec'), env.STATS.get('dwell:' + d + ':n'),
                ]);
                const n = parseInt(dn || '0', 10);
                rows.push({
                    d, pv: parseInt(pv || '0', 10), uv: parseInt(uv || '0', 10),
                    avg: n ? Math.round((parseInt(dsec || '0', 10)) / n) : 0,
                });
            }

            const rowsHtml = rows.map(r =>
                `<tr><td>${r.d}</td><td>${r.pv}</td><td>${r.uv}</td><td>${fmtDuration(r.avg)}</td></tr>`
            ).join('');

            const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex,nofollow">
<title>站点访问统计</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 20px; color: #141413; background: #FAF9F5; }
  h1 { font-size: 1.4rem; }
  .cards { display: flex; gap: 12px; margin: 24px 0 32px; flex-wrap: wrap; }
  .card { flex: 1; min-width: 140px; background: #F3F1EA; border: 1px solid #E8E6DC; border-radius: 8px; padding: 16px; }
  .card .num { font-size: 1.8rem; font-weight: 600; }
  .card .label { font-size: 0.85rem; color: #5A5955; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.95rem; }
  th, td { text-align: left; padding: 8px 4px; border-bottom: 1px solid #E8E6DC; }
  th { color: #5A5955; font-weight: 500; font-size: 0.85rem; }
</style></head><body>
<h1>站点访问统计</h1>
<div class="cards">
  <div class="card"><div class="num">${tpv || 0}</div><div class="label">累计浏览量 (PV)</div></div>
  <div class="card"><div class="num">${tuv || 0}</div><div class="label">累计独立访客 (IP 去重)</div></div>
  <div class="card"><div class="num">${fmtDuration(totalAvg)}</div><div class="label">平均停留时间</div></div>
</div>
<h1 style="font-size:1.1rem">近 14 天</h1>
<table>
  <tr><th>日期</th><th>浏览量</th><th>独立访客</th><th>平均停留</th></tr>
  ${rowsHtml}
</table>
</body></html>`;
            return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        }

        return new Response('Not found', { status: 404 });
    },
};
