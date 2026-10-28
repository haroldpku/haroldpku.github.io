/**
 * 私有访问统计 Worker（Cloudflare Workers + KV）
 *
 * 部署前提：
 *   1. KV namespace 绑定到本 Worker，变量名：STATS
 *   2. Worker Settings → Variables and Secrets 添加 Secret：STATS_KEY
 *      （统计页密钥 + IP 哈希盐，不要写进代码、不要提交到仓库）
 *
 * 接口：
 *   POST /report   {type:'pv', ref, lang} 或 {type:'dwell', seconds:n}
 *   GET  /stats?key=<STATS_KEY>   私有统计页（密钥不对返回 404）
 *
 * 指标：PV、独立访客（IP 加盐哈希）、停留时间、来源地区、来源渠道、
 *       设备类型、语言版本、访问时段。全部为聚合计数，不留原始 IP 等个人信息。
 */

// 东八区日期/小时
function cstDay(offsetDays = 0) {
    return new Date(Date.now() + 8 * 3600e3 - offsetDays * 86400e3).toISOString().slice(0, 10);
}
function cstHour() {
    return new Date(Date.now() + 8 * 3600e3).getUTCHours();
}

// IP 加盐哈希：可去重，不落盘原始 IP
async function hashIp(env, ip, scope) {
    const data = new TextEncoder().encode(env.STATS_KEY + '|' + scope + '|' + ip);
    const buf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function incr(env, key, by = 1) {
    const cur = parseInt(await env.STATS.get(key) || '0', 10);
    await env.STATS.put(key, String(cur + by));
}

async function getNum(env, key) {
    return parseInt(await env.STATS.get(key) || '0', 10);
}

// 按前缀聚合计数器并取 Top N（依赖 KV 的 prefix list）
async function collectPrefix(env, prefix, limit = 10) {
    const list = await env.STATS.list({ prefix });
    const pairs = await Promise.all(
        list.keys.map(async k => [k.name.slice(prefix.length), await getNum(env, k.name)])
    );
    pairs.sort((a, b) => b[1] - a[1]);
    return pairs.slice(0, limit);
}

function fmtDuration(sec) {
    if (!sec) return '—';
    const m = Math.floor(sec / 60), s = sec % 60;
    return m ? `${m}分${s}秒` : `${s}秒`;
}

// 常见来源域名友好名
const REF_NAMES = {
    'direct': '直接访问',
    'google.com': 'Google', 'bing.com': 'Bing', 'baidu.com': '百度',
    'zhihu.com': '知乎', 'mp.weixin.qq.com': '微信公众号', 'weixin.qq.com': '微信',
    'scholar.google.com': 'Google Scholar', 'github.com': 'GitHub',
    'linkedin.com': 'LinkedIn', 'x.com': 'X (Twitter)', 'twitter.com': 'Twitter',
    'duckduckgo.com': 'DuckDuckGo', 'sogou.com': '搜狗', 'so.com': '360搜索',
};

// 常见国家/地区代码友好名（未列出的显示原始代码）
const GEO_NAMES = {
    CN: '中国大陆', HK: '中国香港', TW: '中国台湾', MO: '中国澳门',
    US: '美国', JP: '日本', SG: '新加坡', KR: '韩国',
    GB: '英国', DE: '德国', FR: '法国', CA: '加拿大', AU: '澳大利亚',
    NL: '荷兰', SE: '瑞典', CH: '瑞士', RU: '俄罗斯', IN: '印度',
};

function refHost(ref, ownHost) {
    if (!ref) return 'direct';
    try {
        let h = new URL(ref).hostname.replace(/^www\./, '');
        if (!h || h === ownHost) return 'direct';
        return h;
    } catch (e) { return 'direct'; }
}

function deviceType(ua) {
    ua = ua || '';
    if (/iPad|Tablet|PlayBook/i.test(ua)) return 'tablet';
    if (/Mobile|iPhone|iPod|Android.*Mobile|Windows Phone/i.test(ua)) return 'mobile';
    return 'desktop';
}

function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

                // 独立访客（当日哈希 + 累计哈希）
                const hd = await hashIp(env, ip, day);
                if (!(await env.STATS.get('ip:' + day + ':' + hd))) {
                    await env.STATS.put('ip:' + day + ':' + hd, '1', { expirationTtl: 40 * 86400 });
                    await incr(env, 'uv:' + day);
                }
                const ha = await hashIp(env, ip, 'all');
                if (!(await env.STATS.get('ipall:' + ha))) {
                    await env.STATS.put('ipall:' + ha, '1');
                    await incr(env, 'uv:total');
                }

                // 来源地区（Cloudflare 自带，无需存 IP）
                const cf = request.cf || {};
                const country = cf.country || '??';
                await incr(env, 'geo:' + country);
                if (cf.city) await incr(env, 'city:' + country + ':' + cf.city);

                // 来源渠道（取访客 referrer 的域名）
                const ownHost = 'haroldpku.github.io';
                await incr(env, 'ref:' + refHost(String(body.ref || ''), ownHost));

                // 设备类型（UA 粗判）
                await incr(env, 'dev:' + deviceType(request.headers.get('User-Agent')));

                // 语言版本
                await incr(env, 'lang:' + (body.lang === 'en' ? 'en' : 'zh'));

                // 访问时段（东八区）
                await incr(env, 'hour:' + cstHour());

            } else if (body.type === 'dwell') {
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

            // 总量卡片
            const [tpv, tuv, tsec, tn] = await Promise.all([
                getNum(env, 'pv:total'), getNum(env, 'uv:total'),
                getNum(env, 'dwell:sec'), getNum(env, 'dwell:n'),
            ]);
            const totalAvg = tn ? Math.round(tsec / tn) : 0;

            // 近 14 天
            const rows = [];
            for (let i = 0; i < 14; i++) {
                const d = cstDay(i);
                const [pv, uv, dsec, dn] = await Promise.all([
                    getNum(env, 'pv:' + d), getNum(env, 'uv:' + d),
                    getNum(env, 'dwell:' + d + ':sec'), getNum(env, 'dwell:' + d + ':n'),
                ]);
                rows.push({ d, pv, uv, avg: dn ? Math.round(dsec / dn) : 0 });
            }

            // 细分维度
            const [geo, cities, refs, devM, devD, devT, langZh, langEn] = await Promise.all([
                collectPrefix(env, 'geo:'),
                collectPrefix(env, 'city:'),
                collectPrefix(env, 'ref:'),
                getNum(env, 'dev:mobile'), getNum(env, 'dev:desktop'), getNum(env, 'dev:tablet'),
                getNum(env, 'lang:zh'), getNum(env, 'lang:en'),
            ]);
            const hours = await Promise.all(
                Array.from({ length: 24 }, (_, h) => getNum(env, 'hour:' + h))
            );

            // ---- 渲染辅助 ----
            const barTable = (pairs, nameFn) => {
                if (!pairs.length) return '<p class="empty">暂无数据</p>';
                const max = Math.max(...pairs.map(p => p[1]), 1);
                const total = pairs.reduce((s, p) => s + p[1], 0);
                return '<table>' + pairs.map(([k, v]) =>
                    `<tr><td class="dim">${esc(nameFn(k))}</td><td class="val">${v}</td>` +
                    `<td class="barcell"><div class="bar" style="width:${Math.round(v / max * 100)}%"></div></td>` +
                    `<td class="pct">${Math.round(v / total * 100)}%</td></tr>`
                ).join('') + '</table>';
            };

            const geoHtml = barTable(geo, k => GEO_NAMES[k] || k);
            const cityHtml = barTable(cities, k => k.split(':').slice(1).join(':')); // 去掉国家前缀
            const refHtml = barTable(refs, k => REF_NAMES[k] || k);

            const devPairs = [['电脑', devD], ['手机', devM], ['平板', devT]].filter(p => p[1] > 0);
            const devHtml = barTable(devPairs, k => k);

            const langPairs = [['中文', langZh], ['English', langEn]].filter(p => p[1] > 0);
            const langHtml = barTable(langPairs, k => k);

            const maxHour = Math.max(...hours, 1);
            const hourHtml = '<div class="hourchart">' + hours.map((v, h) =>
                `<div class="hcol" title="${h}时: ${v}次"><div class="hbar" style="height:${Math.round(v / maxHour * 100)}%"></div><div class="hlab">${h % 6 === 0 ? h : ''}</div></div>`
            ).join('') + '</div>';

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
  h2 { font-size: 1.05rem; margin: 36px 0 12px; border-bottom: 1px solid #E8E6DC; padding-bottom: 8px; }
  .cards { display: flex; gap: 12px; margin: 24px 0 8px; flex-wrap: wrap; }
  .card { flex: 1; min-width: 140px; background: #F3F1EA; border: 1px solid #E8E6DC; border-radius: 8px; padding: 16px; }
  .card .num { font-size: 1.8rem; font-weight: 600; }
  .card .label { font-size: 0.85rem; color: #5A5955; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
  th, td { text-align: left; padding: 7px 4px; border-bottom: 1px solid #E8E6DC; }
  th { color: #5A5955; font-weight: 500; font-size: 0.85rem; }
  td.dim { width: 42%; }
  td.val { width: 56px; font-weight: 600; }
  td.pct { width: 52px; color: #5A5955; font-size: 0.85rem; }
  td.barcell { width: 30%; }
  .bar { height: 8px; background: #D97757; border-radius: 4px; opacity: 0.75; min-width: 2px; }
  .empty { color: #5A5955; font-size: 0.9rem; }
  .hourchart { display: flex; align-items: flex-end; gap: 3px; height: 90px; margin-top: 8px; }
  .hcol { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; height: 100%; }
  .hbar { background: #D97757; border-radius: 2px 2px 0 0; opacity: 0.75; min-height: 1px; }
  .hlab { font-size: 0.65rem; color: #5A5955; text-align: center; height: 14px; margin-top: 3px; }
</style></head><body>
<h1>站点访问统计</h1>
<div class="cards">
  <div class="card"><div class="num">${tpv}</div><div class="label">累计浏览量 (PV)</div></div>
  <div class="card"><div class="num">${tuv}</div><div class="label">累计独立访客 (IP 去重)</div></div>
  <div class="card"><div class="num">${fmtDuration(totalAvg)}</div><div class="label">平均停留时间</div></div>
</div>

<h2>来源地区（国家/地区）</h2>
${geoHtml}

<h2>来源城市 Top 10</h2>
${cityHtml}

<h2>来源渠道</h2>
${refHtml}

<h2>设备类型</h2>
${devHtml}

<h2>语言版本</h2>
${langHtml}

<h2>访问时段分布（东八区，每 6 小时一个刻度）</h2>
${hourHtml}

<h2>近 14 天明细</h2>
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
