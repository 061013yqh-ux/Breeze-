const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encode(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decode(value) {
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0));
}

async function sessionKey(secret) {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", hash, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(value, purpose, secret, seconds) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = encoder.encode(JSON.stringify({value, expires: Date.now() + seconds * 1000}));
  const packed = await crypto.subtle.encrypt({name: "AES-GCM", iv, additionalData: encoder.encode(purpose)}, await sessionKey(secret), data);
  return encode(iv) + "." + encode(new Uint8Array(packed));
}

export async function readToken(request, purpose, secret) {
  const cookie = request.headers.get("cookie")?.split(/;\s*/).find(piece => piece.startsWith(purpose + "="));
  if (!cookie || cookie.length > 4060) return null;
  try {
    const [iv, encrypted] = cookie.slice(purpose.length + 1).split(".");
    const plaintext = await crypto.subtle.decrypt({name: "AES-GCM", iv: decode(iv), additionalData: encoder.encode(purpose)}, await sessionKey(secret), decode(encrypted));
    const token = JSON.parse(decoder.decode(plaintext));
    return token.expires > Date.now() ? token.value : null;
  } catch {
    return null;
  }
}

export function setCookie(name, value, seconds) {
  return name + "=" + value + "; Path=/api; Max-Age=" + seconds + "; HttpOnly; Secure; SameSite=Strict";
}
