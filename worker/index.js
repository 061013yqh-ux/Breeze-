import qrCode from "qrcode-generator";
import {staticFiles} from "site-assets";
import {netease} from "./netease.js";
import {readToken, seal, setCookie} from "./session.js";

const flowName = "corridor_qr";
const authName = "corridor_music";
const flowLife = 180;
const sessionLife = 86400;
const listSize = 40;
const songSize = 60;
const coverFile = /^\/([a-zA-Z0-9_-]{8,90}={0,2})\/([1-9]\d{7,28}\.(?:jpg|jpeg|png|webp))$/i;
const coverSize = 224;
const coverHost = /^p[1-4]\.music\.126\.net$/;
const validId = value => /^[1-9]\d{0,15}$/.test(String(value)) && Number.isSafeInteger(Number(value));
const routes = new Map([
  ["/api/account", "GET"], ["/api/login/start", "POST"], ["/api/login/check", "POST"],
  ["/api/logout", "POST"], ["/api/playlists", "GET"], ["/api/tracks", "GET"], ["/api/lyrics", "GET"], ["/api/play", "POST"]
]);

function json(value, status = 200, cookies = []) {
  const headers = new Headers({"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"});
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(JSON.stringify(value), {status, headers});
}

function expiredSession() {
  return json({error: "网易云登录已失效，请重新扫码。"}, 401, [setCookie(authName, "", 0)]);
}

function playableUrl(value) {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.port || url.username || url.password) return null;
    if (!/(^|\.)music\.126\.net$|(^|\.)music\.163\.com$/i.test(url.hostname)) return null;
    url.protocol = "https:";
    return url.href;
  } catch {
    return null;
  }
}

function coverPath(value) {
  try {
    const url = new URL(value);
    const path = decodeURIComponent(url.pathname);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port ||
        !coverHost.test(url.hostname) || !coverFile.test(path)) return null;
    return "/cover/" + url.hostname + path + "?size=" + coverSize;
  } catch {
    return null;
  }
}

async function serveCover(request, pathname, context) {
  const [, , host, ...pieces] = pathname.split("/");
  const remotePath = "/" + pieces.join("/");
  if (request.method !== "GET" || !coverHost.test(host) || !coverFile.test(remotePath)) return new Response(null, {status: 404});
  const cache = context?.waitUntil ? globalThis.caches?.default : undefined;
  const cacheKey = new URL(pathname, request.url);
  cacheKey.searchParams.set("size", coverSize);
  if (cache) {
    try {
      const cached = await cache.match(cacheKey.href);
      if (cached) return cached;
    } catch {}
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6500);
  try {
    const source = new URL("https://" + host + remotePath);
    source.searchParams.set("param", coverSize + "y" + coverSize);
    const options = {signal: controller.signal, redirect: "manual"};
    let image = await fetch(source.href, options);
    if ([301, 302, 303, 307, 308].includes(image.status) && image.headers.has("Location")) {
      const destination = new URL(image.headers.get("Location"), source);
      if (destination.protocol === "https:" && coverPath(destination.href)) {
        await image.body?.cancel();
        image = await fetch(destination.href, options);
      }
    }
    const mediaType = image.headers.get("Content-Type")?.split(";")[0].toLowerCase();
    const type = mediaType === "image/jpg" ? "image/jpeg" : mediaType;
    if (!image.ok || !/^image\/(?:jpeg|png|webp|gif)(?:;|$)/i.test(type || "")) {
      console.warn("NetEase cover unavailable", host, image.status, type?.split(";")[0]);
      await image.body?.cancel();
      return new Response(null, {status: 404});
    }
    if (Number(image.headers.get("Content-Length")) > 2500000) return new Response(null, {status: 404});
    const response = new Response(image.body, {headers: {
      "Content-Type": type, "Cache-Control": "public, max-age=604800", "X-Content-Type-Options": "nosniff"
    }});
    if (cache) {
      const copy = response.clone();
      context.waitUntil(Promise.resolve().then(() => cache.put(cacheKey.href, copy)).catch(() => {}));
    }
    return response;
  } catch (error) {
    console.warn("NetEase cover request failed", host, controller.signal.aborted ? "TIMEOUT" : error?.name === "TypeError" ? "TypeError" : "Error");
    return new Response(null, {status: 502});
  } finally {
    clearTimeout(timer);
  }
}

function accountFrom(body) {
  const profile = body.profile;
  if (body.code !== 200 || !validId(profile?.userId)) return null;
  return {id: String(profile.userId), nickname: String(profile.nickname || "网易云音乐用户").slice(0, 100)};
}

function playlistEntry(playlist) {
  return {
    id: String(playlist.id), name: String(playlist.name || "未命名歌单").slice(0, 110),
    count: Number(playlist.trackCount) || 0, cover: coverPath(playlist.coverImgUrl)
  };
}

function trackEntry(track) {
  const artists = Array.isArray(track.ar) ? track.ar : Array.isArray(track.artists) ? track.artists : [];
  return {
    id: String(track.id), name: String(track.name || "未命名歌曲").slice(0, 110),
    artist: artists.map(artist => artist?.name).filter(name => typeof name === "string").join(" / ").slice(0, 180),
    cover: coverPath(track.al?.picUrl || track.album?.picUrl)
  };
}

function offsetFrom(url) {
  const offset = Number(url.searchParams.get("offset") || 0);
  return Number.isSafeInteger(offset) && offset >= 0 && offset <= 10000 ? offset : null;
}

async function handleApi(request, url, secret) {
  const method = routes.get(url.pathname);
  if (!method) return json({error: "接口不存在。"}, 404);
  if (method !== request.method) return json({error: "请求方式有误。"}, 405);
  if (request.headers.get("sec-fetch-site") === "cross-site" ||
      (method === "POST" && request.headers.get("origin") !== url.origin)) {
    return json({error: "请在 Breeze 页面内操作。"}, 403);
  }
  if (typeof secret !== "string" || secret.length < 32) {
    return json({error: "网易云音乐服务尚未配置。"}, 503);
  }
  const auth = await readToken(request, authName, secret);
  switch (url.pathname) {
    case "/api/account":
      return json({profile: auth?.profile || null});
    case "/api/logout":
      return json({ok: true}, 200, [setCookie(authName, "", 0), setCookie(flowName, "", 0)]);
    case "/api/login/start": {
      if (auth) return json({profile: auth.profile});
      const recent = await readToken(request, flowName, secret);
      if (recent && Date.now() - recent.created < 8000) return qrResponse(recent, []);
      const deviceId = crypto.randomUUID().replaceAll("-", "").toUpperCase();
      const result = await netease("/api/login/qrcode/unikey", {type: 3}, {deviceId});
      const key = result.body.unikey;
      if (result.body.code !== 200 || typeof key !== "string" || !/^[\w-]{8,160}$/.test(key)) {
        return json({error: "网易云暂未签发二维码，请稍后重试。"}, 502);
      }
      const flow = {key, deviceId, created: Date.now(), auth: result.auth.NMTID ? {NMTID: result.auth.NMTID} : {}};
      return qrResponse(flow, [setCookie(flowName, await seal(flow, flowName, secret, flowLife), flowLife)]);
    }
    case "/api/login/check": {
      if (auth) return json({status: "authorized", profile: auth.profile});
      const flow = await readToken(request, flowName, secret);
      if (!flow) return json({status: "expired"});
      const result = await netease("/api/login/qrcode/client/login", {type: 3, key: flow.key}, flow);
      switch (Number(result.body.code)) {
        case 800:
          return json({status: "expired"}, 200, [setCookie(flowName, "", 0)]);
        case 801:
          return json({status: "waiting"});
        case 802:
          return json({status: "scanned"});
        case 803: {
          if (!result.auth.MUSIC_U) return json({error: "网易云未返回有效登录凭据，请刷新二维码后重试。"}, 502);
          const account = await netease("/api/nuser/account/get", {}, {web: true, auth: result.auth, deviceId: flow.deviceId});
          const profile = accountFrom(account.body);
          if (!profile) return json({error: "网易云尚未确认账号信息，请重新扫码。"}, 502);
          const session = {auth: {...result.auth, ...account.auth}, profile, deviceId: flow.deviceId};
          const token = await seal(session, authName, secret, sessionLife);
          if (token.length > 3800) return json({error: "登录凭据超出可保存长度。"}, 502);
          return json({status: "authorized", profile}, 200, [
            setCookie(authName, token, sessionLife), setCookie(flowName, "", 0)
          ]);
        }
        default:
          return json({error: "网易云暂未确认扫码状态，请刷新二维码。"}, 502);
      }
    }
    case "/api/playlists": {
      if (!auth) return json({error: "请先登录网易云音乐。"}, 401);
      const offset = offsetFrom(url);
      if (offset === null) return json({error: "歌单分页有误。"}, 400);
      const result = await netease("/api/user/playlist", {
        uid: auth.profile.id, limit: listSize, offset, includeVideo: false
      }, {...auth, web: true});
      if (result.body.code === 301) return expiredSession();
      if (result.body.code !== 200 || !Array.isArray(result.body.playlist)) {
        return json({error: "暂时无法读取歌单。"}, 502);
      }
      return json({playlists: result.body.playlist.filter(item => validId(item?.id)).map(playlistEntry), more: result.body.more === true, next: offset + listSize});
    }
    case "/api/tracks": {
      if (!auth) return json({error: "请先登录网易云音乐。"}, 401);
      const id = url.searchParams.get("id");
      const offset = offsetFrom(url);
      if (!validId(id) || offset === null) return json({error: "歌单编号或分页有误。"}, 400);
      const info = await netease("/api/v6/playlist/detail", {id, n: 1000, s: 0}, auth);
      const list = info.body.playlist;
      if (info.body.code === 301) return expiredSession();
      if (info.body.code !== 200 || !list) return json({error: "无法读取这份歌单。"}, 502);
      const refs = Array.isArray(list.trackIds) ? list.trackIds : Array.isArray(list.tracks) ? list.tracks : [];
      const total = refs.length;
      const slots = refs.slice(offset, offset + songSize).map((track, index) => ({id: track?.id, slot: offset + index}))
        .filter(track => validId(track.id));
      const more = total > offset + songSize;
      const next = offset + songSize;
      if (slots.length === 0) return json({tracks: [], total, more, next});
      const result = await netease("/api/v3/song/detail", {c: JSON.stringify(slots.map(({id}) => ({id})))}, {...auth, web: true});
      if (result.body.code === 301) return expiredSession();
      if (result.body.code !== 200 || !Array.isArray(result.body.songs)) {
        return json({error: "暂时无法加载这份歌单的歌曲。"}, 502);
      }
      const songs = new Map(result.body.songs.filter(item => validId(item?.id)).map(item => [String(item.id), trackEntry(item)]));
      const tracks = slots.flatMap(({id, slot}) => {
        const track = songs.get(String(id));
        return track ? [{...track, slot}] : [];
      });
      return json({tracks, total, more, next});
    }
    case "/api/lyrics": {
      if (!auth) return json({error: "请先登录网易云音乐。"}, 401);
      const id = url.searchParams.get("id");
      if (!validId(id)) return json({error: "歌曲编号有误。"}, 400);
      const result = await netease("/api/song/lyric", {id, lv: -1, tv: 0, rv: -1, kv: -1}, auth);
      if (result.body.code === 301) return expiredSession();
      if (result.body.code !== 200) return json({error: "暂时无法加载歌词。"}, 502);
      const lyric = result.body.lrc?.lyric;
      return json({lyric: typeof lyric === "string" ? lyric.slice(0, 40000) : ""});
    }
    case "/api/play": {
      const id = url.searchParams.get("id");
      if (!validId(id)) return json({error: "歌曲编号有误。"}, 400);
      const result = await netease("/api/song/enhance/player/url", {ids: JSON.stringify([id]), br: 128000}, auth || {deviceId: crypto.randomUUID().replaceAll("-", "")});
      const item = Array.isArray(result.body.data) ? result.body.data.find(track => String(track.id) === id) : null;
      const source = result.body.code === 200 && item?.code === 200 && playableUrl(item.url);
      if (!source || item.freeTrialInfo || item.freeTrialPrivilege?.cannotListenReason > 0) {
        return json({error: auth ? "当前歌曲无法在这里完整播放。" : "当前歌曲不可用，可登录后再试。"}, 403);
      }
      return json({source});
    }
  }
}

function qrResponse(flow, cookies) {
  const url = new URL("/login", "https://music.163.com");
  url.searchParams.set("codekey", flow.key);
  const qr = qrCode(0, "M");
  qr.addData(url.href);
  qr.make();
  return json({link: url.href, image: qr.createDataURL(6, 24)}, 200, cookies);
}

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/cover/")) return serveCover(request, url.pathname, context);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, url, env.MUSIC_SESSION_SECRET);
      } catch (error) {
        const kind = ["TypeError", "RangeError", "ReferenceError", "SyntaxError", "AbortError"].includes(error?.name) ? error.name : "Error";
        console.warn("Music route failed", url.pathname, kind);
        return json({error: "暂时连不上网易云音乐，请稍后重试。"}, 502);
      }
    }
    const entry = staticFiles[url.pathname];
    if (!Array.isArray(entry) || !["GET", "HEAD"].includes(request.method)) return new Response("页面不存在", {status: 404});
    const [type, content] = entry;
    return new Response(request.method === "HEAD" ? null : content, {headers: {
      "Content-Type": type, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src https://*.music.126.net https://*.music.163.com https://music.126.net https://music.163.com; object-src 'none'; base-uri 'none'; form-action 'self'",
      "Cache-Control": "no-cache"
    }});
  }
};
