const room = {inner: 9.45, outer: 14.15, height: 3.85};
const centerline = (room.inner + room.outer) / 2;
const turn = 2 * Math.PI;
const spacing = turn / 32;
const point = (theta, radius, height = 0) => [Math.sin(theta) * radius, height, Math.cos(theta) * radius];
const subtract = (a, b) => a.map((value, i) => value - b[i]);
const add = (a, b) => a.map((value, i) => value + b[i]);
const scale = (a, factor) => a.map(value => value * factor);
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const unit = a => scale(a, 1 / (Math.hypot(...a) || 1));
const thetaAt = slot => -.03 + slot * spacing;
export const cycleIndex = (value, length) => ((value % length) + length) % length;
export const angleDelta = (from, to) => cycleIndex(to - from + Math.PI, turn) - Math.PI;

export function wallAt(slot, inner = slot % 2 !== 0) {
  const theta = thetaAt(slot);
  const center = point(theta, inner ? room.inner : room.outer);
  const normal = point(theta, inner ? 1 : -1);
  return {center, normal, right: cross([0, 1, 0], normal), theta, inner};
}

export function walkPose(position, mobile) {
  const angle = thetaAt(position) - (mobile ? .352 : .29);
  return {angle, yaw: angle + Math.PI / 2 + (mobile ? .235 : .195)};
}

export const slotAtPose = pose => Math.round((pose.angle + .03) / spacing);
export const walkLead = mobile => (mobile ? .352 : .29) / spacing;

export function focusPose(slot) {
  const wall = wallAt(slot);
  return {angle: wall.theta, yaw: wall.theta + (wall.inner ? Math.PI : 0)};
}

export function cameraFromPose(pose) {
  const eye = point(pose.angle, centerline, 1.62);
  return {eye, aim: add(eye, point(pose.yaw, 1))};
}

export function wallPlane(wall, {height, width, y, depth, shift = 0}) {
  const center = add(wall.center, scale(wall.right, shift));
  const at = add(add(center, [0, y, 0]), scale(wall.normal, depth));
  const right = scale(wall.right, width / 2);
  const up = [0, height / 2, 0];
  return [add(subtract(at, right), up), add(add(at, right), up), subtract(add(at, right), up), subtract(subtract(at, right), up)];
}

function view(camera, width, height) {
  const z = unit(subtract(camera.eye, camera.aim));
  const x = unit(cross([0, 1, 0], z));
  const y = cross(z, x);
  const aspect = width / height;
  const f = Math.min(1 / Math.tan(57 * Math.PI / 360), aspect / Math.tan(84 * Math.PI / 360));
  const near = .035;
  const far = 60;
  const matrix = new Float32Array(16);
  const tx = -dot(x, camera.eye);
  const ty = -dot(y, camera.eye);
  const tz = -dot(z, camera.eye);
  const a = (far + near) / (near - far);
  const b = 2 * far * near / (near - far);
  for (let i = 0; i < 3; i++) matrix.set([x[i] * f / aspect, y[i] * f, z[i] * a, -z[i]], i * 4);
  matrix.set([tx * f / aspect, ty * f, tz * a + b, -tz], 12);
  return matrix;
}

function clipPoint(matrix, [x, y, z]) {
  const at = i => matrix[i]*x + matrix[i+4]*y + matrix[i+8]*z + matrix[i+12];
  return {x: at(0), y: at(1), w: at(3)};
}

const screenPoint = (point, width, height) => ({
  x: (point.x / point.w + 1) * width / 2,
  y: (1 - point.y / point.w) * height / 2,
  w: point.w
});

function outside(points, width, height) {
  return points.every(p => p.x < 0) || points.every(p => p.x > width) ||
    points.every(p => p.y < 0) || points.every(p => p.y > height);
}

function wallView(camera, wall) {
  const fromWall = subtract(camera.eye, wall.center);
  const facing = dot(fromWall, wall.normal);
  const ray = [fromWall[0], 0, fromWall[2]];
  const t = Math.max(0, Math.min(1, -dot(wall.center, ray) / (dot(ray, ray) || 1)));
  const clearance = Math.hypot(...add(wall.center, scale(ray, t))) - room.inner;
  return {facing, clearance};
}

export function wallProjector(camera, width, height) {
  const matrix = view(camera, width, height);
  return (wall, vertices) => {
    const {facing, clearance} = wallView(camera, wall);
    if (facing <= 0 || clearance < -.03) return null;
    const clipped = vertices.map(vertex => clipPoint(matrix, vertex));
    if (clipped.some(point => point.w <= .065)) return null;
    const points = clipped.map(point => screenPoint(point, width, height));
    return outside(points, width, height) ? null : points;
  };
}

export function wallTextProjector(camera, width, height) {
  const matrix = view(camera, width, height);
  const uv = [[0, 0], [1, 0], [1, 1], [0, 1]];
  return (wall, vertices) => {
    const {facing, clearance} = wallView(camera, wall);
    const visibility = Math.min(1, facing / .24, 1 + clearance / .10);
    if (visibility <= 0) return null;
    const corners = vertices.map((vertex, i) => {
      const [u, v] = uv[i];
      return {...clipPoint(matrix, vertex), u, v};
    });
    const nearEdge = corners.some(point => point.w < .065);
    const outline = nearEdge ? clipNear(corners) : corners;
    if (outline.length < 3) return null;
    const points = outline.map(point => screenPoint(point, width, height));
    if (outside(points, width, height)) return null;
    return {points, corners, visibility, clip: nearEdge ? outline : null};
  };
}

export function wallTextTransform(corners, width, height, textWidth, textHeight) {
  // Keep the homogeneous coordinates so a corner crossing the near plane cannot flip the text.
  const normalize = 4 / Math.max(.26, corners.reduce((sum, point) => sum + point.w, 0));
  const [a, b, , d] = corners.map(({x, y, w}) => [
    (x + w) * width * .5 * normalize, (w - y) * height * .5 * normalize, w * normalize
  ]);
  const right = subtract(b, a).map(value => value / textWidth);
  const down = subtract(d, a).map(value => value / textHeight);
  return "matrix3d(" + [
    right[0], right[1], 0, right[2], down[0], down[1], 0, down[2],
    0, 0, 1, 0, a[0], a[1], 0, a[2]
  ].join(",") + ")";
}

export function planeTransform(points, width, height) {
  const [a, b, c, d] = points;
  const dx1 = b.x - c.x, dx2 = d.x - c.x, dx3 = a.x - b.x + c.x - d.x;
  const dy1 = b.y - c.y, dy2 = d.y - c.y, dy3 = a.y - b.y + c.y - d.y;
  const denominator = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(denominator) < .001) return null;
  const g = (dx3 * dy2 - dx2 * dy3) / denominator;
  const h = (dx1 * dy3 - dx3 * dy1) / denominator;
  return "matrix3d(" + [
    (b.x-a.x+g*b.x)/width, (b.y-a.y+g*b.y)/width, 0, g/width,
    (d.x-a.x+h*d.x)/height, (d.y-a.y+h*d.y)/height, 0, h/height,
    0, 0, 1, 0,
    a.x, a.y, 0, 1
  ].join(",") + ")";
}

function architecture(segments) {
  const faces = [];
  function strip(r1, r2, h1, h2, colors) {
    for (let i = 0; i < segments; i++) {
      const a = turn * i / segments;
      const b = turn * (i+1) / segments;
      const tone = (theta, shade) => scale(shade, .983 + .017 * Math.cos(theta * 8));
      faces.push({
        points: [point(a,r1,h1), point(b,r1,h1), point(b,r2,h2), point(a,r2,h2)],
        colors: [tone(a,colors[0]), tone(b,colors[0]), tone(b,colors[1]), tone(a,colors[1])]
      });
    }
  }
  strip(room.inner,room.outer,0,0,[[.737,.724,.76],[.701,.683,.725]]);
  strip(room.outer,room.outer,0,1.64,[[.883,.873,.903],[.972,.968,.982]]);
  strip(room.outer,room.outer,1.64,room.height,[[.972,.968,.982],[.867,.854,.891]]);
  strip(room.inner,room.inner,0,1.64,[[.858,.843,.879],[.921,.910,.942]]);
  strip(room.inner,room.inner,1.64,room.height,[[.921,.910,.942],[.837,.824,.86]]);
  strip(room.inner,room.outer,room.height,room.height,[[.825,.809,.853],[.877,.867,.903]]);
  return faces;
}

function resize(canvas, width, height) {
  const limit = width < height * 1.04 ? 1.65 : 2;
  const ratio = Math.min(devicePixelRatio || 1, limit, Math.sqrt(1400000 / (width * height)));
  const w = Math.round(width * ratio), h = Math.round(height * ratio);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return ratio;
}

const vertex = "attribute vec3 p;attribute vec3 col;uniform mat4 vp;varying vec3 color;varying vec3 world;void main(){world=p;color=col;gl_Position=vp*vec4(p,1.0);}";
const neutralLighting = {color: [.67,.61,.82], strength: 0};
const fragment = `
  precision mediump float;
  varying vec3 color;
  varying vec3 world;
  uniform vec3 eye;
  uniform vec3 lightColor;
  uniform float lightStrength;

  void main() {
    float fog=smoothstep(8.0,30.0,length(world-eye))*.50;
    float surface=clamp(world.y*.13+.3,.30,.80);
    vec3 wash=vec3(.54)+lightColor*.46;
    vec3 paint=mix(color,wash,lightStrength*surface);
    paint=mix(paint,mix(vec3(.887,.874,.91),wash,lightStrength*.35),fog);
    gl_FragColor=vec4(paint,1.0);
  }
`;

export function createScene(canvas, onLost) {
  const gl = canvas.getContext("webgl", {antialias:true, alpha:false, powerPreference:"low-power"});
  if (!gl) throw new Error("WebGL unavailable");
  const program = gl.createProgram();
  for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  const data = [];
  for (const face of architecture(144)) {
    for (const i of [0,1,2,0,2,3]) data.push(...face.points[i], ...face.colors[i]);
  }
  gl.useProgram(program);
  gl.enable(gl.DEPTH_TEST);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
  for (const [index, name] of ["p", "col"].entries()) {
    const attribute = gl.getAttribLocation(program, name);
    gl.enableVertexAttribArray(attribute);
    gl.vertexAttribPointer(attribute, 3, gl.FLOAT, false, 24, index * 12);
  }
  const vp = gl.getUniformLocation(program, "vp");
  const eye = gl.getUniformLocation(program, "eye");
  const lightColor = gl.getUniformLocation(program, "lightColor");
  const lightStrength = gl.getUniformLocation(program, "lightStrength");
  canvas.addEventListener("webglcontextlost", onLost, {once: true});
  return (camera, width, height, lighting = neutralLighting) => {
    resize(canvas, width, height);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(.9,.889,.925,1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.uniformMatrix4fv(vp, false, view(camera, width, height));
    gl.uniform3fv(eye, camera.eye);
    gl.uniform3fv(lightColor, lighting.color);
    gl.uniform1f(lightStrength, lighting.strength);
    gl.drawArrays(gl.TRIANGLES, 0, data.length / 6);
  };
}

function clipNear(vertices) {
  const visible = [];
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i], b = vertices[(i+1) % vertices.length];
    if (a.w >= .065) visible.push(a);
    if ((a.w >= .065) !== (b.w >= .065)) {
      const weight = (.065 - a.w) / (b.w - a.w);
      const edge = {x: a.x + (b.x-a.x)*weight, y: a.y + (b.y-a.y)*weight, w: .065};
      if (a.u !== undefined) {
        edge.u = a.u + (b.u-a.u)*weight;
        edge.v = a.v + (b.v-a.v)*weight;
      }
      visible.push(edge);
    }
  }
  return visible;
}

export function createCanvasScene(canvas) {
  const ctx = canvas.getContext("2d", {alpha:false});
  if (!ctx) throw new Error("Canvas unavailable");
  const faces = architecture(84).map(({points, colors}) => ({
    points, height: points.reduce((sum, point) => sum + point[1] / 4, 0), color: [0,1,2].map(channel => colors.reduce((sum, color) => sum + color[channel] / 4, 0))
  }));
  return (camera, width, height, lighting = neutralLighting) => {
    const ratio = resize(canvas, width, height);
    const matrix = view(camera, width, height);
    ctx.setTransform(ratio,0,0,ratio,0,0);
    ctx.fillStyle = "#e4e1ea";
    ctx.fillRect(0,0,width,height);
    const wash = lighting.color.map(channel => .54 + channel * .46);
    const draws = [];
    for (const face of faces) {
      const clipped = clipNear(face.points.map(vertex => clipPoint(matrix, vertex)));
      if (clipped.length < 3) continue;
      const points = clipped.map(point => screenPoint(point, width, height));
      if (outside(points, width, height)) continue;
      draws.push({points, depth: clipped.reduce((sum,p) => sum+p.w, 0) / clipped.length, color: face.color, elevation:face.height});
    }
    draws.sort((a,b) => b.depth-a.depth);
    for (const {points, depth, color, elevation} of draws) {
      const fog = Math.min(.5, Math.max(0, (depth-8)/48));
      const strength = lighting.strength * Math.min(.80, .30 + elevation * .13);
      const channels = color.map((channel,i) => {
        const paint = channel * (1-strength) + wash[i] * strength;
        return Math.round((paint*(1-fog)+[.887,.874,.91][i]*fog)*255);
      });
      ctx.fillStyle = ctx.strokeStyle = "rgb(" + channels.join(",") + ")";
      ctx.lineWidth = .55;
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (const p of points.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  };
}
