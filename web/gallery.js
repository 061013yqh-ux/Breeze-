import {lyricAt, parseLrc} from "./lyrics.js";
import {coverLight} from "./atmosphere.js";
import {createCorridorLyrics} from "./corridor-lyrics.js";
import {angleDelta, cameraFromPose, createCanvasScene, createScene, cycleIndex, focusPose,
  planeTransform, slotAtPose, walkLead, walkPose, wallAt, wallPlane, wallProjector, wallTextProjector} from "./scene.js";

const $ = id => document.getElementById(id);
const stage = $("stage");
let canvas = $("scene");
const wallLayer = $("wall-layer");
const lyricPanel = $("wall-lyrics");
const walkingLyrics = $("walking-lyrics");
const corridorLyrics = createCorridorLyrics($("corridor-lyrics"));
const lyricLookAhead = .65;
const player = $("player");
const playerArt = $("player-art");
const audio = $("audio");
const library = $("library");
const account = $("account");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const mobile = () => stage.clientWidth < stage.clientHeight * 1.04;
const colors = ["#a22634", "#304c77", "#3f654b", "#a65c43", "#70567e", "#367775"];
const pageSize = 60;
const coverOffsets = [1, 2, 3, 4, 5, 6, 7, 8, 0, 9, 10, 11, 12, -1, -2];
const galleryCover = {width: 1.4, height: 1.4, y: 2.34, depth: .08};
const playingCover = {...galleryCover, y: 1.88, shift: -1.02};
const floatingLyrics = {width: 1.95, height: 1.46, y: 1.88, depth: .28, shift: .79};

let profile = null;
let wallList;
let position = 0;
let target = 0;
let pose;
let focusedSlot;
let pointer;
let suppressTapUntil = 0;
let autoResumeAt = 0;
let frame = 0;
let lastFrame = 0;
let preloadAt;
let preloadDestination;
let coverWindow;
let renderScene;
const atmosphere = {color: [.67,.61,.82], strength: 0};
let targetLight = atmosphere.color;
let targetStrength = 0;
const painted = new Map();
const loadingCovers = new Set();
let immersive = false;
let enteredFullscreen = false;

let playingSlot;
let selection = 0;
let activeRequest;
let advanceRequest;
let upcomingAudio;
let loadState = "empty";
let lyrics = [];
let lyricMessage = "";
let lastLyric = -2;

let loginRequest;
let libraryMode = "personal";
let listRequest;
let listRows = [];
let listNext = 0;
let listMore = false;
let wallShown = pageSize;
let libraryError = "";
let signOutPending = false;

function setCover(image, track, priority = "auto", onSettled) {
  const background = colors[Number(String(track.id).slice(-3)) % colors.length];
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="' + background + '" d="M0 0h100v100H0z"/><path fill="#fff7ee" d="M45 30l29-7v37a10 7-12 1 1-5-5V38l-19 4v24a10 7-12 1 1-5-5z"/></svg>';
  const fallback = "data:image/svg+xml," + encodeURIComponent(svg);
  image.decoding = "async";
  image.fetchPriority = priority;
  image.classList.remove("cover-ready");
  const loaded = () => {
    const source = image.src;
    const ready = () => {
      if (image.onload !== loaded || image.src !== source || !image.naturalWidth || image.classList.contains("cover-ready")) return;
      image.classList.add("cover-ready");
      onSettled?.();
    };
    if (onSettled && image.decode) image.decode().then(ready, ready);
    else ready();
  };
  image.onload = loaded;
  image.onerror = () => {
    if (image.getAttribute("src") !== fallback) image.src = fallback;
    else onSettled?.();
  };
  image.src = track.cover || fallback;
  if (image.complete && image.naturalWidth) loaded();
}

function wallCover(slot, track, priority) {
  let element = painted.get(slot);
  if (!element) {
    element = document.createElement("button");
    element.type = "button";
    element.className = "wall-cover";
    element.dataset.slot = slot;
    element.hidden = true;
    const image = new Image();
    image.alt = "";
    element.append(image);
    element.addEventListener("click", () => {
      if (performance.now() >= suppressTapUntil) playAt(slot);
    });
    painted.set(slot, element);
    wallLayer.append(element);
  }
  const image = element.firstElementChild;
  if (element.dataset.track !== track.id) {
    element.dataset.track = track.id;
    element.setAttribute("aria-label", "播放 " + track.name + (track.artist ? " · " + track.artist : ""));
    loadingCovers.add(element);
    setCover(image, track, priority, () => {
      loadingCovers.delete(element);
      coverWindow = undefined;
      schedule();
    });
  } else if (priority === "high" && image.fetchPriority !== "high" && loadingCovers.has(element)) {
    image.fetchPriority = "high";
  }
  return element;
}

function releaseCover(slot, element) {
  const image = element.firstElementChild;
  image.onload = image.onerror = null;
  image.removeAttribute("src");
  loadingCovers.delete(element);
  element.remove();
  painted.delete(slot);
}

function bufferWallCovers(center, destination) {
  if (!wallList?.total || (coverWindow?.center === center && coverWindow.destination === destination)) return;
  coverWindow = {center, destination};
  const near = coverOffsets.map(offset => center + offset);
  const ahead = coverOffsets.map(offset => destination + offset);
  const slots = new Set(center === destination ? near : [...near.slice(0, 4), ...ahead, ...near]);
  const retained = (slot, origin) => slot >= origin - 6 && slot <= origin + 14;
  for (const [slot, element] of painted) {
    if (!retained(slot, center) && !retained(slot, destination)) releaseCover(slot, element);
  }
  for (const slot of slots) {
    if (loadingCovers.size >= 6) break;
    const track = trackAt(slot);
    if (track && !painted.has(slot)) wallCover(slot, track, "low");
  }
}

async function api(path, method = "GET", signal) {
  const response = await fetch("/api/" + path, {method, signal, credentials: "same-origin", cache: "no-store"});
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    throw Object.assign(new Error(data?.error || "连接暂时中断，请稍后重试。"), {status: response.status});
  }
  return data;
}

function setNote(message) {
  const note = $("stage-note");
  note.textContent = message || "";
  note.hidden = !message;
}

function schedule() {
  if (!frame) frame = requestAnimationFrame(render);
}

function canvasFallback() {
  try {
    renderScene = createCanvasScene(canvas);
    canvas.dataset.mode = "canvas";
  } catch {
    canvas.hidden = true;
    lyricPanel.dataset.flat = "";
    wallLayer.hidden = true;
    renderScene = undefined;
  }
  schedule();
}

try {
  renderScene = createScene(canvas, () => {
    const replacement = canvas.cloneNode();
    canvas.replaceWith(replacement);
    canvas = replacement;
    canvasFallback();
  });
  canvas.dataset.mode = "webgl";
} catch {
  canvasFallback();
}

function drawPlane(element, projected, width, height) {
  const transform = projected && planeTransform(projected, width, height);
  element.hidden = !transform;
  if (!transform) return;
  element.style.transform = transform;
  const depth = projected.reduce((sum, point) => sum + point.w / 4, 0);
  element.style.zIndex = String(Math.max(1, 100 - Math.round(depth * 3)));
}

function nearestSlot(index) {
  const count = wallList?.total;
  if (!count) return 0;
  return index + Math.round((position - index) / count) * count;
}

function trackAt(slot) {
  return wallList?.total ? wallList.tracks.get(cycleIndex(slot, wallList.total)) : undefined;
}

function activeTrackId() {
  if (playingSlot === undefined || player.hidden) return undefined;
  return trackAt(playingSlot)?.id;
}

function smoothRange(value, start, end) {
  const progress = Math.min(1, Math.max(0, (value - start) / (end - start)));
  return progress * progress * (3 - 2 * progress);
}

function wallLyricVisibility(points, width, height) {
  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  const left = Math.min(...xs), right = Math.max(...xs);
  const top = Math.min(...ys), bottom = Math.max(...ys);
  const visibleWidth = Math.min(width, right) - Math.max(0, left);
  const visibleHeight = Math.min(height, bottom) - Math.max(0, top);
  return smoothRange(visibleWidth, 28, Math.max(44, Math.min(width * .25, 100))) *
    smoothRange(visibleWidth / Math.max(1, right - left), .08, .68) *
    smoothRange(visibleHeight / Math.max(1, bottom - top), .15, .7);
}

function updateLyricPlacement(wallOpacity) {
  lyricPanel.style.opacity = String(wallOpacity);
  const onWall = walkingLyrics.hidden || wallOpacity >= .5;
  lyricPanel.setAttribute("aria-hidden", String(!onWall));
  walkingLyrics.setAttribute("aria-hidden", String(onWall));
  walkingLyrics.style.opacity = String(1 - wallOpacity);
}

function locateLyricWall(project, center, trackId, width, height) {
  if (!trackId) return null;

  const first = focusedSlot ?? center - 5;
  const last = focusedSlot ?? center + 11;
  let nearest = null;
  for (let slot = first; slot <= last; slot++) {
    if (trackAt(slot)?.id !== trackId) continue;
    const wall = wallAt(slot);
    const lettering = project(wall, wallPlane(wall, floatingLyrics));
    if (!lettering) continue;
    const opacity = wallLyricVisibility(lettering, width, height);
    const depth = lettering.reduce((sum, point) => sum + point.w / lettering.length, 0);
    if (!nearest || opacity > nearest.opacity + .08 || (Math.abs(opacity - nearest.opacity) <= .08 && depth < nearest.depth)) {
      nearest = {slot, lettering, depth, opacity};
    }
  }
  return nearest;
}

function drawWalls(camera, center, width, height) {
  const project = wallProjector(camera, width, height);
  const trackId = activeTrackId();
  const lyricWall = locateLyricWall(project, center, trackId, width, height);
  const highlightedSlot = focusedSlot ?? lyricWall?.slot;
  const used = new Set();
  for (let slot = center - 5; slot <= center + 11; slot++) {
    const track = trackAt(slot);
    if (!track) continue;
    const wall = wallAt(slot);
    const surface = wallPlane(wall, track.id === trackId ? playingCover : galleryCover);
    const projected = project(wall, surface);
    if (!projected) continue;
    const element = wallCover(slot, track, projected[0].w < 4.5 ? "high" : "auto");
    used.add(slot);
    const current = slot === highlightedSlot ? "true" : "false";
    if (element.getAttribute("aria-current") !== current) element.setAttribute("aria-current", current);
    drawPlane(element, projected, 256, 256);
  }
  for (const [slot, element] of painted) {
    if (!element.hidden && !used.has(slot)) element.hidden = true;
  }
  drawPlane(lyricPanel, lyricWall?.lettering, 448, 300);
  updateLyricPlacement(lyricPanel.hidden ? 0 : lyricWall.opacity);
}

function updateAtmosphere(elapsed) {
  const blend = 1 - Math.exp(-elapsed * 2.9);
  atmosphere.color = atmosphere.color.map((value, index) => value + (targetLight[index] - value) * blend);
  atmosphere.strength += (targetStrength - atmosphere.strength) * blend;
  return Math.abs(targetStrength - atmosphere.strength) > .003 ||
    (targetStrength > 0 && atmosphere.color.some((value, index) => Math.abs(value - targetLight[index]) > .005));
}

function resetAtmosphere(active) {
  targetStrength = active ? .58 : 0;
  schedule();
}

function inLyricCorridor() {
  return immersive && !player.hidden && playingSlot !== undefined;
}

playerArt.addEventListener("load", () => {
  if (player.hidden) return;
  targetLight = coverLight(playerArt) || targetLight;
  schedule();
});

function render(now) {
  frame = 0;
  const elapsed = Math.min(.05, (lastFrame ? now - lastFrame : 16) / 1000);
  lastFrame = now;
  const lyricMode = inLyricCorridor();
  const advancing = lyricMode && !audio.paused && !audio.ended && audio.readyState >= 2 && !document.hidden;
  const automatic = advancing && !pointer && now >= autoResumeAt;
  const noMotion = reduceMotion.matches;
  if (automatic) target += elapsed * (noMotion ? .31 : .43);

  const width = Math.max(1, stage.clientWidth), height = Math.max(1, stage.clientHeight);
  const portrait = width < height * 1.04;
  const blend = 1 - Math.exp(-elapsed * 9);
  position = noMotion || Math.abs(target - position) < .002 ? target : position + (target-position) * blend;
  const desired = focusedSlot === undefined ? walkPose(position, portrait) : focusPose(focusedSlot);
  if (!pose || noMotion) pose = {...desired};
  const angle = desired.angle - pose.angle;
  const yaw = angleDelta(pose.yaw, desired.yaw);
  pose.angle += Math.abs(angle) < .001 ? angle : angle * blend;
  pose.yaw += Math.abs(yaw) < .001 ? yaw : yaw * blend;

  const center = slotAtPose(pose);
  const travel = Math.max(-9, Math.min(9, target - position));
  const destination = Math.abs(travel) >= .75 ? slotAtPose(walkPose(position + travel, portrait)) : center;
  if (center !== preloadAt || destination !== preloadDestination) {
    preloadAt = center;
    preloadDestination = destination;
    preloadVisible(center);
    if (destination !== center) preloadVisible(destination);
  }
  const atmosphericMotion = updateAtmosphere(elapsed);
  const walking = position !== target || Math.abs(angle) > .001 || Math.abs(yaw) > .001;
  if (walking || atmosphericMotion || advancing) schedule();
  const camera = cameraFromPose(pose);
  stage.classList.toggle("lyric-corridor", lyricMode);
  if (renderScene) renderScene(camera, width, height, atmosphere);
  if (lyricMode) {
    if (renderScene) bufferWallCovers(center, destination);
    corridorLyrics.draw({
      lines: lyrics, index: lastLyric, message: lyricMessage, center, width, height,
      project: renderScene ? wallTextProjector(camera, width, height) : null,
      projectAhead: () => wallTextProjector(cameraFromPose(walkPose(position + lyricLookAhead, portrait)), width, height)
    });
    return;
  }

  corridorLyrics.hide();
  if (renderScene) {
    drawWalls(camera, center, width, height);
    bufferWallCovers(center, destination);
  } else {
    const slot = focusedSlot ?? Math.round(position);
    const track = trackAt(slot);
    $("stage-fallback").hidden = !track;
    if (track && $("fallback-image").dataset.track !== track.id) {
      $("fallback-image").dataset.track = track.id;
      setCover($("fallback-image"), track);
      $("fallback-work").setAttribute("aria-label", "播放 " + track.name);
    }
    const displayLyrics = Boolean(track && track.id === activeTrackId());
    stage.classList.toggle("flat-playing", displayLyrics);
    lyricPanel.hidden = !displayLyrics;
    updateLyricPlacement(displayLyrics ? 1 : 0);
  }
}

function resumeWalking() {
  if (focusedSlot === undefined) return;
  position = target = focusedSlot + walkLead(mobile());
  focusedSlot = undefined;
}

function walkBy(amount) {
  autoResumeAt = performance.now() + 740;
  resumeWalking();
  target += amount;
  schedule();
}

stage.addEventListener("wheel", event => {
  event.preventDefault();
  const amount = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  const scale = event.deltaMode === 1 ? 18 : event.deltaMode === 2 ? stage.clientHeight : 1;
  walkBy(Math.max(-1.3, Math.min(1.3, amount * scale / 340)));
}, {passive: false});

stage.addEventListener("pointerdown", event => {
  if (!event.isPrimary || event.button !== 0) return;
  pointer = {id:event.pointerId, x:event.clientX, y:event.clientY, distance:0};
});
stage.addEventListener("pointermove", event => {
  if (pointer?.id !== event.pointerId) return;
  const dx = pointer.x - event.clientX;
  const dy = pointer.y - event.clientY;
  pointer.distance += Math.hypot(dx, dy);
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  if (pointer.distance <= 8) return;
  if (!stage.hasPointerCapture(pointer.id)) stage.setPointerCapture(pointer.id);
  stage.classList.add("dragging");
  walkBy((Math.abs(dx) > Math.abs(dy) ? dx : dy) / 132);
});

function finishDrag(event) {
  if (pointer?.id !== event.pointerId) return;
  if (pointer.distance > 8 || event.type === "pointercancel") {
    suppressTapUntil = performance.now() + 180;
    autoResumeAt = performance.now() + 540;
  }
  pointer = undefined;
  stage.classList.remove("dragging");
}

stage.addEventListener("pointerup", finishDrag);
stage.addEventListener("pointercancel", finishDrag);
stage.addEventListener("pointerleave", event => {
  if (!stage.hasPointerCapture(event.pointerId)) finishDrag(event);
});
function setImmersive(enabled) {
  immersive = enabled;
  document.body.classList.toggle("immersive", enabled);
  $("header").inert = enabled;
  player.inert = enabled;
  if (enabled && inLyricCorridor()) {
    resumeWalking();
    autoResumeAt = performance.now() + 380;
  }
  schedule();
  if (!enabled) {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    return;
  }
  stage.focus({preventScroll: true});
  const request = document.documentElement.requestFullscreen;
  if (!request) return;
  request.call(document.documentElement, {navigationUI:"hide"})
    .then(() => { if (!immersive && document.fullscreenElement) return document.exitFullscreen(); })
    .catch(() => {});
}

document.addEventListener("fullscreenchange", () => {
  if (document.fullscreenElement) {
    enteredFullscreen = true;
  } else if (enteredFullscreen) {
    enteredFullscreen = false;
    setImmersive(false);
  }
});

stage.addEventListener("click", event => {
  if (event.target.closest("button") || performance.now() < suppressTapUntil) return;
  if (immersive || wallList?.total) setImmersive(!immersive);
});

stage.addEventListener("keydown", event => {
  const steps = {ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1};
  if (steps[event.key]) {
    event.preventDefault();
    walkBy(steps[event.key]);
  } else if (event.key === "Enter" && event.target === stage && !inLyricCorridor()) {
    playAt(Math.round(position));
  } else if (event.key.toLowerCase() === "f" && (immersive || wallList?.total)) {
    setImmersive(!immersive);
  } else if (event.key === "Escape" && immersive) {
    setImmersive(false);
  } else if (event.key === "Escape") {
    walkBy(0);
  }
});
$("fallback-work").onclick = () => playAt(focusedSlot ?? Math.round(position));
new ResizeObserver(schedule).observe(stage);
new ResizeObserver(() => stage.style.setProperty("--player-height", player.offsetHeight + "px")).observe(player);

function fetchSongPage(list, offset) {
  const previous = list.pages.get(offset);
  if (previous) return previous;
  const pending = api("tracks?id=" + encodeURIComponent(list.id) + "&offset=" + offset, "GET", list.controller.signal)
    .then(data => {
      if (wallList !== list) return;
      list.total = data.total;
      for (const track of data.tracks) list.tracks.set(track.slot, track);
      coverWindow = undefined;
      schedule();
    })
    .catch(error => {
      list.pages.delete(offset);
      throw error;
    });
  list.pages.set(offset, pending);
  return pending;
}

function preloadVisible(center) {
  const list = wallList;
  if (!list?.total) return;
  const offsets = new Set();
  for (let slot = center - 6; slot <= center + 12; slot++) {
    const index = cycleIndex(slot, list.total);
    offsets.add(Math.floor(index / pageSize) * pageSize);
  }
  for (const offset of offsets) fetchSongPage(list, offset).catch(() => {});
}

function saveSelection(list) {
  try {
    const entry = {id: list.id, name: list.name};
    localStorage.setItem("sound-corridor-playlist-" + profile.id, JSON.stringify(entry));
  } catch {}
}

function lastSelection() {
  try {
    const raw = localStorage.getItem("sound-corridor-playlist-" + profile.id);
    if (!raw) return null;
    if (/^\d+$/.test(raw)) return {id: raw};
    const entry = JSON.parse(raw);
    return typeof entry?.id === "string" && /^\d+$/.test(entry.id) && typeof entry.name === "string"
      ? entry : null;
  } catch {
    return null;
  }
}

function clearWalls() {
  if (immersive) setImmersive(false);
  wallList?.controller.abort();
  wallList = undefined;
  for (const [slot, element] of painted) releaseCover(slot, element);
  closePlayer();
  position = target = 0;
  pose = undefined;
  preloadAt = undefined;
  preloadDestination = undefined;
  coverWindow = undefined;
  wallShown = pageSize;
  $("fallback-image").removeAttribute("data-track");
  schedule();
}

async function selectPlaylist(entry) {
  if (entry.id === wallList?.id && wallList.total !== undefined) return;
  clearWalls();
  const list = {...entry, controller:new AbortController(), tracks:new Map(), pages:new Map()};
  wallList = list;
  setNote("正在把歌单放到墙上…");
  try {
    await fetchSongPage(list, 0);
    if (wallList !== list) return;
    if (list.total) {
      saveSelection(list);
      setNote("");
      preloadVisible(slotAtPose(pose || walkPose(position, mobile())));
    } else {
      setNote("这份歌单还没有歌曲，可在右上角更换");
    }
    if (library.open) renderLibrary();
  } catch (error) {
    if (wallList === list) {
      setNote(error.message);
      if (error.status === 401) setProfile(null);
    }
  }
}

function promptForPlaylist() {
  setNote("选一份歌单，歌曲就会出现在墙上");
  openLibrary("personal");
}

async function restorePlaylist(owner) {
  const saved = lastSelection();
  if (!saved) {
    promptForPlaylist();
    return;
  }
  if (saved.name) {
    selectPlaylist(saved);
    return;
  }
  setNote("正在恢复上次选择的歌单…");
  try {
    const {playlists} = await api("playlists?offset=0");
    if (profile !== owner || wallList) return;
    const entry = playlists.find(item => item.id === saved.id);
    if (entry) selectPlaylist(entry);
    else promptForPlaylist();
  } catch (error) {
    if (profile !== owner || wallList) return;
    if (error.status === 401) setProfile(null);
    else setNote(error.message);
  }
}

function lyricFrame(index, currentOnly) {
  const frame = document.createElement("div");
  frame.className = "lyric-frame";
  const lines = [
    ["lyric-adjacent lyric-previous", index > 0 ? lyrics[index - 1].text : ""],
    ["lyric-current", index >= 0 ? lyrics[index].text : lyricMessage],
    ["lyric-adjacent lyric-next", lyrics[index + 1]?.text || ""]
  ];
  for (const [kind, text] of currentOnly ? [lines[1]] : lines) {
    const line = document.createElement("p");
    line.className = kind;
    line.textContent = text;
    frame.append(line);
  }
  return frame;
}

function visibleLyric(panel) {
  let visible;
  for (const frame of panel.children) {
    const style = getComputedStyle(frame);
    const opacity = Number(style.opacity);
    if (opacity > (visible?.opacity ?? .04)) {
      visible = {frame, opacity, transform: style.transform};
    }
  }
  return visible;
}

function renderLyric(panel, index, duration, previousIndex, currentOnly = false) {
  const previous = previousIndex >= 0 && index >= 0 ? visibleLyric(panel) : null;
  const incoming = lyricFrame(index, currentOnly);
  if (index < 0) {
    panel.replaceChildren(incoming);
    return;
  }

  incoming.style.setProperty("--lyric-duration", duration + "ms");
  incoming.dataset.fade = previous ? "in" : "first";
  if (!previous) {
    panel.replaceChildren(incoming);
    return;
  }

  const outgoing = previous.frame.cloneNode(true);
  outgoing.dataset.fade = "out";
  outgoing.setAttribute("aria-hidden", "true");
  outgoing.style.setProperty("--lyric-duration", duration + "ms");
  outgoing.style.setProperty("--lyric-opacity", previous.opacity);
  outgoing.style.transform = previous.transform;
  outgoing.addEventListener("animationend", () => outgoing.remove(), {once: true});
  panel.replaceChildren(outgoing, incoming);
}

function syncLyrics() {
  const index = lyricAt(lyrics, audio.currentTime);
  if (lastLyric === index) return;
  const previousIndex = lastLyric;
  lastLyric = index;
  const gap = index >= 0 ? lyrics[index + 1]?.time - lyrics[index].time : 0;
  // Keep the slower fade on normal lines and fit short lines to the song's timing.
  const duration = Number.isFinite(gap) && gap > 0 ? Math.min(1500, Math.max(320, gap * 900)) : 1500;
  renderLyric(lyricPanel, index, duration, previousIndex);
  walkingLyrics.hidden = index < 0;
  if (walkingLyrics.hidden) walkingLyrics.replaceChildren();
  else renderLyric(walkingLyrics, index, duration, previousIndex, true);
  schedule();
}

function showLyrics(lines, message) {
  lyrics = lines;
  lyricMessage = message;
  lastLyric = -2;
  syncLyrics();
}

async function fetchLyrics(track, request) {
  try {
    const {lyric} = await api("lyrics?id=" + encodeURIComponent(track.id), "GET", request.signal);
    if (activeRequest !== request) return;
    const lines = parseLrc(lyric || "");
    showLyrics(lines, lines.length ? "♫" : "暂无歌词");
  } catch (error) {
    if (activeRequest !== request) return;
    if (error.status === 401) setProfile(null);
    else showLyrics([], "歌词暂时无法加载");
  }
}

function syncPlayer() {
  const playing = !audio.paused && !audio.ended;
  $("play-toggle").setAttribute("aria-label", playing ? "暂停" : "播放");
  $("play-toggle").querySelector("use").setAttribute("href", playing ? "#icon-pause" : "#icon-play");
  $("play-toggle").disabled = loadState !== "ready";
  $("song-prev").disabled = $("song-next").disabled = !(wallList?.total > 1);
}

function playStatus(text) {
  $("play-status").textContent = text;
  $("dock-meta").hidden = !text;
  $("official-link").hidden = loadState !== "unavailable";
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  return Math.floor(seconds / 60) + ":" + String(Math.floor(seconds) % 60).padStart(2, "0");
}

function syncTimeline() {
  const seek = $("seek");
  const ready = !!audio.getAttribute("src") && Number.isFinite(audio.duration) && audio.duration > 0;
  seek.disabled = !ready;
  seek.max = ready ? audio.duration : 1;
  seek.value = ready ? audio.currentTime : 0;
  seek.style.setProperty("--progress", (ready ? 100 * audio.currentTime / audio.duration : 0) + "%");
  $("elapsed").textContent = ready ? formatTime(audio.currentTime) : "0:00";
  $("duration").textContent = ready ? formatTime(audio.duration) : "0:00";
  syncLyrics();
  prepareUpcomingAudio();
}

function faceSong(slot) {
  if (pose && Math.abs(slotAtPose(pose) - slot) > 10) pose = walkPose(slot, mobile());
  focusedSlot = slot;
  position = target = slot;
  schedule();
}

function audioSource(track, signal) {
  return api("play?id=" + encodeURIComponent(track.id), "POST", signal).then(data => data.source);
}

function unavailableTrack(error) {
  return error.status === 403 || error.status === 404;
}

function prepareUpcomingAudio() {
  if (loadState !== "ready" || audio.paused || audio.ended ||
      playingSlot === undefined || !(wallList?.total > 1) ||
      !Number.isFinite(audio.duration) || audio.duration - audio.currentTime > 30) return;

  const list = wallList;
  const index = cycleIndex(playingSlot + 1, list.total);
  const request = activeRequest;
  if (!request || upcomingAudio?.request === request) return;
  const candidate = {list, index, request};
  upcomingAudio = candidate;

  async function prepare() {
    try {
      if (!list.tracks.has(index)) await fetchSongPage(list, Math.floor(index / pageSize) * pageSize);
      const track = list.tracks.get(index);
      if (!track || activeRequest !== request) return;
      candidate.source = await audioSource(track, request.signal);
      candidate.readyAt = Date.now();
    } catch (error) {
      if (!request.signal.aborted && unavailableTrack(error)) {
        candidate.unavailable = true;
        candidate.readyAt = Date.now();
      }
    }
  }

  prepare();
}

function preparedAudio(list, index) {
  const candidate = upcomingAudio;
  return candidate?.list === list && candidate.index === index &&
    Date.now() - candidate.readyAt < 45000 ? candidate : undefined;
}

async function playAt(slot, step = 0, automatic = false) {
  const list = wallList;
  if (!list?.total) return;
  const attempt = ++selection;
  advanceRequest?.abort();
  const advance = new AbortController();
  advanceRequest = advance;

  let track;
  let source;
  const maxTries = automatic ? list.total - 1 : step ? list.total : 1;
  if (automatic) playStatus("正在切换下一首…");
  try {
    for (let i = 0; i < maxTries; i++, slot += step) {
      const index = cycleIndex(slot, list.total);
      if (!list.tracks.has(index)) await fetchSongPage(list, Math.floor(index / pageSize) * pageSize);
      if (attempt !== selection || wallList !== list) return;
      track = list.tracks.get(index);
      if (!track) continue;
      const prepared = preparedAudio(list, index);
      if (!automatic) {
        source = prepared?.source;
        break;
      }
      try {
        if (!prepared?.unavailable) source = prepared?.source || await audioSource(track, advance.signal);
        if (attempt !== selection || wallList !== list) return;
        if (source) break;
      } catch (error) {
        if (attempt !== selection || wallList !== list) return;
        if (!unavailableTrack(error)) throw error;
      }
      track = undefined;
    }
  } catch (error) {
    if (attempt === selection && wallList === list) {
      playStatus(error.message);
      syncPlayer();
    }
    return;
  } finally {
    if (advanceRequest === advance) advanceRequest = undefined;
  }
  if (!track) {
    if (automatic) playStatus("歌单里没有下一首可播放的歌曲。");
    syncPlayer();
    return;
  }

  const alreadyPlaying = !player.hidden && playingSlot !== undefined &&
    cycleIndex(playingSlot, list.total) === cycleIndex(slot, list.total);
  playingSlot = slot;
  if ((!automatic || focusedSlot !== undefined) && !inLyricCorridor()) faceSong(slot);
  else schedule();
  if (alreadyPlaying && loadState !== "unavailable") {
    if (audio.paused && loadState === "ready") audio.play().catch(() => {});
    return;
  }

  activeRequest?.abort();
  upcomingAudio = undefined;
  const request = new AbortController();
  activeRequest = request;
  loadState = "loading";
  audio.pause();
  if (!source) {
    audio.removeAttribute("src");
    audio.load();
  }
  player.hidden = false;
  resetAtmosphere(true);
  setCover(playerArt, track);
  $("player-title").textContent = track.name;
  $("player-artist").textContent = track.artist || "网易云音乐";
  $("official-link").href = "https://music.163.com/song?id=" + encodeURIComponent(track.id);
  playStatus("正在连接网易云音乐…");
  showLyrics([], "正在读取歌词…");
  syncPlayer();
  if (!source) syncTimeline();
  fetchLyrics(track, request);
  try {
    if (!source) source = await audioSource(track, request.signal);
    if (activeRequest !== request) return;
    audio.src = source;
    loadState = "ready";
    playStatus("");
    syncPlayer();
    await audio.play().catch(() => {
      if (activeRequest === request && loadState === "ready") playStatus("点播放继续");
    });
  } catch (error) {
    if (activeRequest !== request) return;
    loadState = "unavailable";
    playStatus(error.message);
    syncPlayer();
  }
}

function closePlayer() {
  selection++;
  advanceRequest?.abort();
  advanceRequest = undefined;
  upcomingAudio = undefined;
  activeRequest?.abort();
  activeRequest = undefined;
  player.hidden = true;
  resetAtmosphere(false);
  lyricPanel.hidden = true;
  loadState = "empty";
  playingSlot = undefined;
  resumeWalking();
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  showLyrics([], "");
  syncTimeline();
  schedule();
}

function shiftSong(step, automatic = false) {
  if (playingSlot === undefined || !wallList?.total) return;
  const index = cycleIndex(playingSlot, wallList.total);
  const nearby = focusedSlot ?? nearestSlot(index);
  playAt(nearby + step, step, automatic);
}

$("player-close").onclick = closePlayer;
$("song-prev").onclick = () => shiftSong(-1);
$("song-next").onclick = () => shiftSong(1);
$("play-toggle").onclick = () => {
  if (loadState !== "ready") return;
  if (!audio.paused) audio.pause();
  else audio.play().catch(() => playStatus("暂时无法播放，可在网易云打开。"));
};
$("seek").oninput = event => { if (!event.target.disabled) audio.currentTime = Number(event.target.value); };
for (const name of ["loadedmetadata", "durationchange", "timeupdate"]) audio.addEventListener(name, syncTimeline);
audio.addEventListener("seeked", syncTimeline);
audio.addEventListener("playing", schedule);
document.addEventListener("visibilitychange", schedule);
audio.onplay = () => { playStatus(""); syncPlayer(); prepareUpcomingAudio(); schedule(); };
audio.onpause = () => { syncPlayer(); schedule(); };
audio.onended = () => {
  if (!audio.ended || loadState !== "ready" || advanceRequest) return;
  if (wallList?.total > 1) shiftSong(1, true);
  else if (wallList?.total === 1) {
    audio.currentTime = 0;
    audio.play().catch(() => {});
  }
};
audio.onerror = () => {
  if (!audio.getAttribute("src")) return;
  loadState = "unavailable";
  playStatus("此音源暂时无法播放，可在网易云打开。");
  syncPlayer();
};

function setProfile(value, choosePlaylist = false) {
  const changed = profile?.id !== value?.id;
  profile = value;
  $("account-button").textContent = value ? "网易云账号" : "网易云登录";
  $("sign-in").hidden = !!value;
  $("signed-in").hidden = !value;
  $("nickname").textContent = value?.nickname || "";
  $("account-status").textContent = "";
  if (changed) clearWalls();
  if (value && choosePlaylist) promptForPlaylist();
  else if (value && changed) restorePlaylist(value);
  if (!value) setNote("登录网易云音乐后，歌单会出现在墙上");
}

function finishLogin(value) {
  hideQr();
  account.close();
  setProfile(value, true);
}

function hideQr() {
  $("qr-box").hidden = true;
  $("qr-link").hidden = true;
  $("qr-image").removeAttribute("src");
  $("qr-link").removeAttribute("href");
}

function openAccount() {
  if (library.open) library.close();
  account.showModal();
  if (!profile) {
    hideQr();
    $("login-status").textContent = "";
    startLogin();
  }
}

function pollAfter(request, delay, retries = 0) {
  setTimeout(() => {
    if (loginRequest === request && account.open && !request.signal.aborted) pollLogin(request, retries);
  }, delay);
}

async function startLogin() {
  loginRequest?.abort();
  const request = new AbortController();
  loginRequest = request;
  hideQr();
  $("qr-refresh").disabled = true;
  $("login-status").textContent = "正在生成二维码…";
  try {
    const data = await api("login/start", "POST", request.signal);
    if (loginRequest !== request) return;
    if (data.profile) {
      finishLogin(data.profile);
      return;
    }
    $("qr-image").src = data.image;
    $("qr-link").href = data.link;
    $("qr-box").hidden = false;
    $("qr-link").hidden = false;
    $("login-status").textContent = "等待扫码";
    pollAfter(request, 2200);
  } catch (error) {
    if (loginRequest === request && !request.signal.aborted) $("login-status").textContent = error.message;
  } finally {
    if (loginRequest === request) {
      $("qr-refresh").disabled = false;
      $("qr-refresh").textContent = "刷新二维码";
    }
  }
}

async function pollLogin(request, retries) {
  try {
    const data = await api("login/check", "POST", request.signal);
    if (loginRequest !== request) return;
    if (data.status === "authorized") {
      hideQr();
      finishLogin(data.profile);
      return;
    }
    if (data.status === "expired") {
      hideQr();
      $("login-status").textContent = "二维码已过期，请刷新。";
      return;
    }
    $("login-status").textContent = data.status === "scanned" ? "已扫码，请在网易云 App 确认" : "等待扫码";
    pollAfter(request, 2500);
  } catch (error) {
    if (loginRequest !== request || request.signal.aborted) return;
    if (retries < 3 && (!error.status || error.status >= 500)) {
      $("login-status").textContent = "连接暂时中断，正在继续检查扫码状态…";
      pollAfter(request, 2500, retries + 1);
    } else $("login-status").textContent = error.message;
  }
}

$("account-button").onclick = openAccount;
$("qr-refresh").onclick = startLogin;
account.addEventListener("close", () => {
  if (account.open) return;
  loginRequest?.abort();
  loginRequest = undefined;
  hideQr();
});
$("my-playlists").onclick = () => { account.close(); openLibrary("personal"); };

$("logout").onclick = async () => {
  if (signOutPending) return;
  signOutPending = true;
  $("logout").disabled = true;
  try {
    await api("logout", "POST");
    listRequest?.abort();
    listRequest = undefined;
    listRows = [];
    setProfile(null);
    hideQr();
    account.close();
  } catch (error) {
    $("account-status").textContent = error.message;
  } finally {
    signOutPending = false;
    $("logout").disabled = false;
  }
};

function button(label, action, className = "pill") {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = label;
  node.className = className;
  node.onclick = action;
  return node;
}

function listMessage(parent, message) {
  const p = document.createElement("p");
  p.className = "sheet-message";
  p.setAttribute("role", "status");
  p.textContent = message;
  parent.append(p);
}

function row(entry, subtitle, action) {
  const node = button("", action, "music-row");
  const art = new Image();
  art.alt = "";
  art.loading = "lazy";
  setCover(art, entry);
  const detail = document.createElement("span");
  const title = document.createElement("strong");
  title.textContent = entry.name;
  const caption = document.createElement("small");
  caption.textContent = subtitle;
  detail.append(title, caption);
  node.append(art, detail);
  return node;
}

function openLibrary(mode = "personal") {
  if (!library.open) library.showModal();
  switchLibrary(mode);
}

function switchLibrary(mode) {
  listRequest?.abort();
  listRequest = undefined;
  libraryMode = mode;
  listRows = [];
  listNext = 0;
  listMore = false;
  libraryError = "";
  for (const control of document.querySelectorAll("[data-library]")) {
    control.setAttribute("aria-pressed", control.dataset.library === mode);
  }
  renderLibrary();
  if (mode === "personal" && profile) loadLibrary();
}

function renderLibrary() {
  const container = $("library-body");
  container.replaceChildren();
  if (!profile) {
    listMessage(container, "登录网易云音乐后，就能把你的歌单放到墙上。");
    container.append(button("扫码登录", openAccount, "pill accent"));
    return;
  }
  if (libraryMode === "wall") {
    if (!wallList?.total) {
      listMessage(container, "选一份歌单，歌曲就会出现在墙上。");
      container.append(button("选择歌单", () => switchLibrary("personal")));
      return;
    }
    const head = document.createElement("div");
    head.className = "list-head";
    const title = document.createElement("strong");
    title.textContent = wallList.name;
    head.append(title, button("更换歌单", () => switchLibrary("personal")));
    container.append(head);
    const list = wallList;
    const tracks = [...list.tracks.values()].filter(track => track.slot < wallShown).sort((a,b) => a.slot-b.slot);
    for (const track of tracks) {
      container.append(row(track, track.artist, () => {
        library.close();
        playAt(nearestSlot(track.slot));
      }));
    }
    if (wallShown < list.total) {
      container.append(button("加载更多", async event => {
        event.target.disabled = true;
        try {
          await fetchSongPage(list, wallShown);
          if (wallList !== list) return;
          wallShown += pageSize;
          if (library.open) renderLibrary();
        } catch (error) {
          if (wallList !== list || !library.open) return;
          event.target.disabled = false;
          listMessage(container, error.message);
        }
      }));
    }
    return;
  }
  for (const entry of listRows) {
    const active = entry.id === wallList?.id;
    const control = row(entry, entry.count + " 首歌曲" + (active ? " · 正在墙上展示" : ""), () => {
      library.close();
      selectPlaylist(entry);
    });
    control.classList.add("playlist-choice");
    if (active) control.setAttribute("aria-current", "true");
    container.append(control);
  }
  if (listRequest) listMessage(container, "正在读取网易云歌单…");
  else if (libraryError) {
    listMessage(container, libraryError);
    container.append(button("重试", loadLibrary));
  } else if (!listRows.length) listMessage(container, "你的账号还没有歌单。");
  if (listMore && !listRequest && !libraryError) container.append(button("加载更多", loadLibrary));
}

async function loadLibrary() {
  if (listRequest) return;
  const request = new AbortController();
  listRequest = request;
  libraryError = "";
  renderLibrary();
  try {
    const data = await api("playlists?offset=" + listNext, "GET", request.signal);
    if (listRequest !== request) return;
    listRows.push(...data.playlists);
    listNext = data.next;
    listMore = data.more;
  } catch (error) {
    if (listRequest !== request) return;
    if (error.status === 401) setProfile(null);
    libraryError = error.message;
  } finally {
    if (listRequest === request) {
      listRequest = undefined;
      renderLibrary();
    }
  }
}

$("library-button").onclick = () => openLibrary();
for (const control of document.querySelectorAll("[data-library]")) control.onclick = () => switchLibrary(control.dataset.library);
for (const control of document.querySelectorAll("[data-close]")) control.onclick = () => $(control.dataset.close).close();
library.addEventListener("close", () => {
  if (library.open) return;
  listRequest?.abort();
  listRequest = undefined;
});
api("account").then(data => setProfile(data.profile)).catch(() => {});
schedule();
