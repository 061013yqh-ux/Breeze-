# Breeze

Breeze 是一个音乐走廊播放器。用网易云音乐扫码登录后，可以选择自己的歌单，沿着走廊看专辑封面。点封面播放，点空白处进入全屏。全屏时镜头自动向前，当前歌曲的歌词从左右墙面淡入淡出。

## 本地运行

需要 Node.js 22 或更新版本。

```bash
npm ci
export MUSIC_SESSION_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
npm run dev
```

在同一台设备的浏览器打开 `http://localhost:4173`。固定保存 `MUSIC_SESSION_SECRET`，重启时沿用同一个值，否则已有登录会话会失效。

## 部署

GitHub 仓库用于发布源码。扫码、歌单和音源查询由 Node 服务处理。公网部署使用 HTTPS，由 Nginx 把网站根路径代理到 `http://127.0.0.1:4173`。

```bash
npm ci
npm run build
PUBLIC_ORIGIN=https://music.example.com npm start
```

把 `music.example.com` 换成实际域名，并在进程环境中设置上面生成的 `MUSIC_SESSION_SECRET`。`npm start` 默认监听 `127.0.0.1:4173`，可用 `HOST` 和 `PORT` 修改。`PUBLIC_ORIGIN` 只填协议和域名，可含端口，使用浏览器实际访问的地址。

## 测试

```bash
npm test
```

测试使用合成数据覆盖登录、歌单、歌词、播放接口和 HTTPS 反代。真实歌单和音源可用性取决于网易云音乐。协议实现的参考项目及许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
