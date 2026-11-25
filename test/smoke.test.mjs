import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {randomBytes} from "node:crypto";
import {once} from "node:events";
import {test} from "node:test";
import worker from "../dist/server/index.js";

const origin = "https://music.example.test";
const env = {MUSIC_SESSION_SECRET: randomBytes(32).toString("hex")};

test("QR login, playlist, lyrics and playback", async t => {
  let checks = 0;
  t.mock.method(globalThis, "fetch", async value => {
    const path = new URL(value).pathname;
    if (path.endsWith("/login/qrcode/client/login")) {
      const code = [801, 802, 803][checks++];
      return Response.json({code}, {headers: code === 803 ? {"Set-Cookie": "MUSIC_U=mock-session; Path=/; HttpOnly"} : {}});
    }
    const results = {
      "/eapi/login/qrcode/unikey": {code: 200, unikey: "a_fixture_qr_key"},
      "/weapi/nuser/account/get": {code: 200, profile: {userId: 300, nickname: "试听用户"}},
      "/weapi/user/playlist": {code: 200, playlist: [null, {id: 420, name: "试听歌单", trackCount: 3}]},
      "/eapi/v6/playlist/detail": {code: 200, playlist: {trackIds: [{id: 101}, null, {id: 102}]}},
      "/weapi/v3/song/detail": {code: 200, songs: [null, {id: 101, name: "试听", ar: [null, {name: "歌手"}]}, {id: 102, ar: {}}]},
      "/eapi/song/lyric": {code: 200, lrc: {lyric: "[00:01.00]一行测试歌词"}},
      "/eapi/song/enhance/player/url": {code: 200, data: [
        {id: 101, code: 200, url: "http://m1.music.126.net/example.mp3"},
        {id: 102, code: 200, url: "https://m1.music.126.net/trial.mp3", freeTrialInfo: {start: 0, end: 20}}
      ]}
    };
    assert.ok(Object.hasOwn(results, path), `Unexpected route ${path}`);
    return Response.json(results[path]);
  });

  const api = (path, method = "GET", cookie) => {
    const headers = {Origin: origin};
    if (cookie) headers.Cookie = cookie;
    return worker.fetch(new Request(origin + "/api/" + path, {method, headers}), env);
  };
  assert.equal((await api("playlists")).status, 401);

  const start = await api("login/start", "POST");
  assert.equal(start.status, 200);
  assert.match((await start.json()).image, /^data:image\/gif;base64,/);
  const flow = start.headers.getSetCookie()[0].split(";")[0];
  for (const status of ["waiting", "scanned"]) {
    assert.deepEqual(await (await api("login/check", "POST", flow)).json(), {status});
  }
  const authorized = await api("login/check", "POST", flow);
  assert.equal((await authorized.json()).status, "authorized");
  const sessionHeader = authorized.headers.getSetCookie()[0];
  assert.match(sessionHeader, /HttpOnly; Secure; SameSite=Strict/);
  const session = sessionHeader.split(";")[0];
  assert.equal((await (await api("account", "GET", session)).json()).profile.nickname, "试听用户");

  const {playlists} = await (await api("playlists", "GET", session)).json();
  assert.deepEqual(playlists.map(entry => entry.id), ["420"]);
  const {tracks} = await (await api("tracks?id=420", "GET", session)).json();
  assert.deepEqual(tracks.map(({id, slot, artist}) => ({id, slot, artist})), [
    {id: "101", slot: 0, artist: "歌手"}, {id: "102", slot: 2, artist: ""}
  ]);
  assert.equal((await (await api("lyrics?id=101", "GET", session)).json()).lyric, "[00:01.00]一行测试歌词");
  assert.equal((await (await api("play?id=101", "POST", session)).json()).source, "https://m1.music.126.net/example.mp3");
  assert.equal((await api("play?id=102", "POST", session)).status, 403);
});

test("Node accepts its configured HTTPS origin and rejects other origins", {timeout: 8000}, async () => {
  const server = spawn(process.execPath, ["worker/dev.mjs"], {
    env: {...process.env, ...env, HOST: "127.0.0.1", PORT: "0", PUBLIC_ORIGIN: origin},
    stdio: ["ignore", "pipe", "inherit"]
  });
  try {
    const ready = await Promise.race([
      once(server.stdout, "data").then(([output]) => String(output)),
      once(server, "exit").then(([code]) => { throw new Error(`Server exited with code ${code}`); })
    ]);
    const port = Number(ready.match(/port (\d+)/)?.[1]);
    assert.ok(port > 0);
    const local = `http://127.0.0.1:${port}`;
    const page = await fetch(local);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>Breeze<\/title>/);
    const signOut = suppliedOrigin => fetch(local + "/api/logout", {method: "POST", headers: {Origin: suppliedOrigin}});
    const permitted = await signOut(origin);
    assert.equal(permitted.status, 200);
    assert.equal(permitted.headers.getSetCookie().length, 2);
    assert.equal((await signOut("https://unrelated.example.test")).status, 403);
  } finally {
    server.kill();
  }
});
