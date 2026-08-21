// 火山引擎 V4 签名（HMAC-SHA256，AWS SigV4 变体）
// 移植自 Minggle/coding-plan-monitor 的 volcano_sign.py（含黄金向量测试）
const crypto = require('crypto');

const CONTENT_TYPE = 'application/json; charset=utf-8';
const SIGNED_HEADERS = 'host;x-date;x-content-sha256;content-type';

function uriEncode(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const hmacSha256 = (key, data) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();

/** OpenAPI 公共参数按 key 字母序拼接 */
function buildCanonicalQuery(action, region, version) {
  const pairs = [['Action', action], ['Region', region], ['Version', version]].sort();
  return pairs.map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join('&');
}

/** 返回一次 POST 所需的全部签名请求头。now 为 Date（按 UTC 处理） */
function signedHeadersV4({ ak, sk, region, service, host, query, body, now }) {
  const xDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); // yyyyMMddTHHmmssZ
  const shortDate = xDate.slice(0, 8);
  const bodyHash = sha256Hex(Buffer.from(body, 'utf8'));

  const canonicalHeaders =
    `host:${host}\n` +
    `x-date:${xDate}\n` +
    `x-content-sha256:${bodyHash}\n` +
    `content-type:${CONTENT_TYPE}\n`;
  const canonicalRequest = `POST\n/\n${query}\n${canonicalHeaders}\n${SIGNED_HEADERS}\n${bodyHash}`;

  const scope = `${shortDate}/${region}/${service}/request`;
  const stringToSign = `HMAC-SHA256\n${xDate}\n${scope}\n${sha256Hex(Buffer.from(canonicalRequest, 'utf8'))}`;

  const kDate = hmacSha256(Buffer.from(sk, 'utf8'), shortDate);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, 'request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  return {
    'X-Date': xDate,
    'X-Content-Sha256': bodyHash,
    'Content-Type': CONTENT_TYPE,
    Authorization:
      `HMAC-SHA256 Credential=${ak}/${scope}, ` +
      `SignedHeaders=${SIGNED_HEADERS}, Signature=${signature}`,
  };
}

module.exports = { buildCanonicalQuery, signedHeadersV4 };
