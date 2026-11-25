import {wallAt, wallPlane, wallTextTransform} from "./scene.js";

const textWidth = 300;
const textHeight = 130;

function screenBounds(points, width, height) {
  const xs = points.map(point => point.x), ys = points.map(point => point.y);
  const left = Math.min(...xs), right = Math.max(...xs);
  const top = Math.min(...ys), bottom = Math.max(...ys);
  const span = Math.max(1, right - left);
  const visibleWidth = Math.min(right, width) - Math.max(left, 0);
  const visibleHeight = Math.min(bottom, height) - Math.max(top, 0);
  return {top, bottom, visibleWidth, visibleHeight, fit: visibleWidth / span, aspect: (bottom - top) / span};
}

function placementQuality(anchor, project, width, height) {
  const view = project(anchor.wall, anchor.surface);
  if (!view || view.clip) return 0;
  const {visibleWidth, fit, aspect, top, bottom} = screenBounds(view.points, width, height);
  if (visibleWidth < Math.min(40, width * .115) || fit < .44 || bottom < height * .15 || top > height * .78) return 0;
  return view.visibility * visibleWidth * fit / Math.max(1, aspect * .76);
}

function edgeFade(value, span) {
  const t = Math.max(0, Math.min(1, value / span));
  return t * t * (3 - 2 * t);
}

function chooseAnchor(cue, center, project, projectAhead, width, height) {
  const options = [];
  const stayingVisible = [];
  const ahead = projectAhead();
  for (let i = 0; i < 30; i++) {
    const wall = wallAt(center + .48 + i * .155, cue.inner);
    const surface = wallPlane(wall, {width: cue.width, height: 1.14, y: cue.elevation, depth: .22});
    const anchor = {wall, surface};
    const quality = placementQuality(anchor, project, width, height);
    if (!quality) continue;
    options.push({anchor, quality});
    const later = placementQuality(anchor, ahead, width, height);
    if (later) stayingVisible.push({anchor, quality: quality + later});
  }
  const candidates = stayingVisible.length ? stayingVisible : options;
  candidates.sort((left, right) => right.quality - left.quality);
  return candidates[Math.floor(cue.seed * Math.min(candidates.length, 4))]?.anchor;
}

function paint(cue, project, width, height) {
  const {node, anchor} = cue;
  const view = anchor && project(anchor.wall, anchor.surface);
  node.style.visibility = view ? "visible" : "hidden";
  if (!view) return;
  const {visibleWidth, visibleHeight} = screenBounds(view.points, width, height);
  const opacity = view.visibility * edgeFade(visibleWidth, Math.min(64, width * .16)) * edgeFade(visibleHeight, 34);
  node.style.setProperty("--corridor-visibility", opacity.toFixed(3));
  node.style.transform = wallTextTransform(view.corners, width, height, textWidth, textHeight);
  node.style.clipPath = view.clip ? "polygon(" + view.clip.map(({u, v}) => `${u * 100}% ${v * 100}%`).join(",") + ")" : "";
}

export function createCorridorLyrics(layer) {
  let cues = [];
  let source;
  let selected = -2;
  let lastSide;
  let previousSide;
  let lastFontSize;

  function clear() {
    layer.replaceChildren();
    cues = [];
    selected = -2;
    lastSide = previousSide = lastFontSize = undefined;
  }

  function add(text, inner, previous = false) {
    const node = document.createElement("div");
    node.className = "corridor-lyric";
    node.style.visibility = "hidden";
    node.dataset.wall = inner ? "left" : "right";
    const lettering = document.createElement("p");
    lettering.textContent = text;
    const sizes = [...text].length > 13 ? [31, 37, 44] : [34, 43, 52];
    const alternatives = sizes.filter(size => lastFontSize === undefined || Math.abs(size - lastFontSize) >= 6);
    lastFontSize = alternatives[Math.floor(Math.random() * alternatives.length)];
    node.style.setProperty("--corridor-font", lastFontSize + "px");
    node.append(lettering);
    layer.append(node);
    const cue = {node, inner, seed: Math.random(), width: 2.70 + Math.random() * .27, elevation: 1.63 + Math.random() * .82};
    cues.push(cue);
    if (previous) retire(cue);
    return cue;
  }

  function retire(cue) {
    if (cue.node.hasAttribute("data-retiring")) return;
    cue.node.dataset.retiring = "";
    cue.retireAt = performance.now() + 2650;
    cue.node.setAttribute("aria-hidden", "true");
    cue.node.addEventListener("animationend", (event) => {
      if (event.target !== cue.node) return;
      cue.node.remove();
      cues = cues.filter(item => item !== cue);
    });
  }

  function select(lines, index, message) {
    if (source !== lines) {
      source = lines;
      selected = -2;
    }
    if (selected === index) return;
    const entering = selected === -2;
    selected = index;
    for (const cue of cues) retire(cue);
    const text = lines[index]?.text || (index < 0 && !lines.length ? message : "");
    if (!text) return;
    const inner = lastSide === undefined ? Math.random() < .5 :
      lastSide === previousSide || Math.random() < .78 ? !lastSide : lastSide;
    const earlier = entering && index > 0 ? lines[index - 1]?.text : "";
    if (earlier && earlier !== text) add(earlier, !inner, true);
    add(text, inner);
    previousSide = lastSide;
    lastSide = inner;
  }

  return {
    hide() {
      if (layer.hidden) return;
      layer.hidden = true;
      clear();
    },
    draw({lines, index, message, center, project, projectAhead, width, height}) {
      layer.hidden = false;
      select(lines, index, message);
      const now = performance.now();
      cues = cues.filter(cue => {
        if (!cue.retireAt || now < cue.retireAt) return true;
        cue.node.remove();
        return false;
      });
      for (const cue of cues) {
        if (!project) {
          cue.node.style.visibility = "visible";
          cue.node.dataset.flat = "";
          cue.node.style.top = (cue.elevation * 17 + 5) + "%";
          continue;
        }
        cue.anchor ??= chooseAnchor(cue, center, project, projectAhead, width, height);
        paint(cue, project, width, height);
      }
    }
  };
}
