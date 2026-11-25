import aes from "crypto-js/aes.js";
import encUtf8 from "crypto-js/enc-utf8.js";
import encHex from "crypto-js/enc-hex.js";
import md5 from "crypto-js/md5.js";
import ecb from "crypto-js/mode-ecb.js";

const pcHost = "https://interfacepc.music.163.com";
const webHost = "https://music.163.com";
const webKey = encUtf8.parse("0CoJUm6Qyw8W8jud");
const webIv = encUtf8.parse("0102030405060708");
const desktopKey = encUtf8.parse("e82ckenh8dichen8");
const publicModulus = BigInt("0xe0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7");
const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const cookieFields = ["MUSIC_U", "__csrf", "NMTID"];

// Wire formats documented by NeteaseCloudMusicApiEnhanced (MIT).
function encryptWeb(data) {
  const key = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => alphabet[byte % alphabet.length]).join("");
  const first = aes.encrypt(JSON.stringify(data), webKey, {iv: webIv}).toString();
  const params = aes.encrypt(first, encUtf8.parse(key), {iv: webIv}).toString();
  let power = 65537;
  let base = BigInt("0x" + encUtf8.parse([...key].reverse().join("")).toString(encHex));
  let encrypted = 1n;
  while (power > 0) {
    if (power % 2) encrypted = encrypted * base % publicModulus;
    base = base * base % publicModulus;
    power = Math.floor(power / 2);
  }
  return {params, encSecKey: encrypted.toString(16).padStart(256, "0")};
}

function encryptDesktop(path, data) {
  const text = JSON.stringify(data);
  const digest = md5("nobody" + path + "use" + text + "md5forencrypt").toString();
  const sep = "-36cd479b6b5-";
  return {params: aes.encrypt(path + sep + text + sep + digest, desktopKey, {mode: ecb}).ciphertext.toString(encHex).toUpperCase()};
}

function credentials(headers) {
  const lines = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : typeof headers.getAll === "function" ? headers.getAll("Set-Cookie") : [];
  return Object.fromEntries(lines.map(line => line.match(/^([^=;]+)=([^;]+)/))
    .filter(match => match && cookieFields.includes(match[1])).map(([, key, value]) => [key, value]));
}

export async function netease(path, data, {auth = {}, deviceId, web = false} = {}) {
  const desktop = {
    os: "pc", osver: "Microsoft-Windows-10-Professional-build-19045-64bit",
    appver: "3.1.17.204416", channel: "netease", deviceId,
    buildver: String(Math.floor(Date.now() / 1000)), resolution: "1920x1080",
    requestId: String(Date.now()), __csrf: auth.__csrf || "", ...auth
  };
  const cookie = Object.entries(web ? {...auth, os: "pc"} : desktop)
    .map(([key, value]) => key + "=" + encodeURIComponent(value)).join("; ");
  const encrypted = web
    ? encryptWeb({...data, csrf_token: auth.__csrf || "", e_r: false})
    : encryptDesktop(path, {...data, header: desktop, e_r: false});
  const host = web ? webHost : pcHost;
  const endpoint = (web ? "/weapi" : "/eapi") + path.slice(4);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8500);
  try {
    const response = await fetch(host + endpoint, {
      method: "POST", redirect: "manual",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": web
          ? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
          : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 NeteaseMusicDesktop/3.1.29.205117",
        Referer: webHost + "/", Cookie: cookie
      },
      body: new URLSearchParams(encrypted).toString(),
      signal: controller.signal
    });
    const content = await response.text();
    let body;
    try {
      body = JSON.parse(content);
    } catch {
      const denied = /access denied|blocked by|security policy|forbidden|banned|拒绝访问/i.test(content);
      throw new Error("HTTP_" + response.status + (denied ? "_DENIED" : "_NON_JSON"));
    }
    if (!body || typeof body !== "object") throw new Error("INVALID_JSON");
    if (response.status >= 300) console.warn("NetEase HTTP status", path, response.status);
    return {body, auth: credentials(response.headers)};
  } catch (error) {
    const detail = String(error?.message || "");
    const category = /^HTTP_\d{3}_(DENIED|NON_JSON)$/.test(detail) ? detail
      : controller.signal.aborted ? "TIMEOUT"
      : /dns|no such host/i.test(detail) ? "DNS"
      : /certificate|tls/i.test(detail) ? "TLS"
      : /destination|policy|disallowed|restricted|prohibited/i.test(detail) ? "EGRESS_DENIED"
      : /header|cookie/i.test(detail) ? "HEADER"
      : /network|connection|fetch|reset/i.test(detail) ? "CONNECTION"
      : "OTHER";
    console.warn("NetEase request did not complete", path, category);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
