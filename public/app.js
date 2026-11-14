// Fixed-product Inquiry Demo. Credentials and defaults stay on the server.
"use strict";
const $ = (id) => document.getElementById(id);
const MEDIA = {
  "image/png": 10 * 1048576,
  "image/jpeg": 10 * 1048576,
  "image/webp": 10 * 1048576,
  "video/mp4": 20 * 1048576,
};
const state = {
  csrf: null,
  product: null,
  inquiry: null,
  current: null,
  messages: new Map(),
  viewEpoch: 0,
  seq: 0,
  nextCursor: null,
  olderLoaded: false,
  drafts: new Map(),
  skippedRating: new Set(),
  timers: [],
  busy: new Set(),
  booting: null,
  connecting: false,
  mediaEnabled: true,
  historyReady: false,
  unread: new Set(),
  pendingScroll: false,
  returnFocus: null,
  soundEnabled: true,
};
const mobileLayout = window.matchMedia("(max-width: 720px)");
let replyAudio = null;
let lastReplySound = -Infinity;
function unlockReplySound() {
  if (!state.soundEnabled) return;
  try {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!replyAudio && Audio) replyAudio = new Audio();
    if (replyAudio?.state === "suspended") replyAudio.resume().catch(() => {});
  } catch {
    /* Audio is optional; chat remains usable when the browser blocks it. */
  }
}
function playReplySound() {
  if (
    !state.soundEnabled ||
    replyAudio?.state !== "running" ||
    performance.now() - lastReplySound < 1000
  )
    return;
  try {
    const start = replyAudio.currentTime;
    for (const [frequency, delay] of [
      [880, 0],
      [1174.66, 0.12],
    ]) {
      const tone = replyAudio.createOscillator(),
        gain = replyAudio.createGain();
      tone.type = "sine";
      tone.frequency.value = frequency;
      gain.gain.setValueAtTime(0, start + delay);
      gain.gain.linearRampToValueAtTime(0.045, start + delay + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, start + delay + 0.2);
      tone.connect(gain);
      gain.connect(replyAudio.destination);
      tone.start(start + delay);
      tone.stop(start + delay + 0.22);
      tone.onended = () => {
        tone.disconnect();
        gain.disconnect();
      };
    }
    lastReplySound = performance.now();
  } catch {
    /* A notification must never interrupt message delivery. */
  }
}
function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k in n && typeof v !== "string") n[k] = v;
    else n.setAttribute(k, v);
  }
  for (const c of children.flat())
    if (c !== null && c !== undefined && c !== false)
      n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}
function clear(n) {
  n.replaceChildren();
}
function friendlyError(e) {
  const code = e?.code;
  if (
    [
      "INSUFFICIENT_SCOPE",
      "INQUIRY_DISABLED",
      "APP_NOT_ENABLED",
      "APP_NOT_MAPPED",
    ].includes(code)
  )
    return "Chat is not enabled for this demo yet. HIOBuy needs to enable inquiry access for the configured App.";
  if (code === "INVALID_API_KEY")
    return "The configured API key could not be verified. Please ask the demo administrator to check it.";
  if (code === "APP_MISMATCH")
    return "The demo configuration has changed. Reload the page to reconnect.";
  return e?.message || "Something went wrong. Please try again.";
}
function showError(node, e) {
  node.hidden = !e;
  node.textContent = e ? friendlyError(e) : "";
}
function fmtTime(iso) {
  const d = new Date(iso);
  return isNaN(d)
    ? ""
    : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function safeCdn(u) {
  try {
    const x = new URL(u),
      ok =
        /^[a-z0-9-]+(\.[a-z0-9-]+)*\.alicdn\.com$/.test(x.hostname) ||
        x.hostname === "global-img-cdn.1688.com";
    return x.protocol === "https:" &&
      ok &&
      !x.port &&
      !x.username &&
      !x.password &&
      /\.(jpe?g|png|webp)(_[A-Za-z0-9.]+)?$/i.test(x.pathname)
      ? x.href
      : null;
  } catch {
    return null;
  }
}
function safeProductUrl(u) {
  return /^https:\/\/(detail\.1688\.com\/offer\/[0-9]{1,20}\.html|(item\.taobao|detail\.tmall)\.com\/item\.htm\?id=[0-9]{1,20}(&skuId=[0-9]{1,20})?)$/.test(
    u,
  )
    ? u
    : null;
}
function safeLocalPath(p) {
  return typeof p === "string" &&
    /^\/api\/conversations\/[0-9]{1,12}\/attachments\/[0-9a-f-]{36}\/content$/.test(
      p,
    )
    ? p
    : null;
}
class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
async function request(method, path, body, { raw = null, headers = {} } = {}) {
  const h = { Accept: "application/json", ...headers };
  if (method !== "GET" && method !== "HEAD") h["X-CSRF-Token"] = state.csrf;
  let payload;
  if (raw) payload = raw;
  else if (body !== undefined) {
    h["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: h,
      body: payload,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    throw new ApiError(
      0,
      "NETWORK_ERROR",
      "Could not connect. Your draft is kept; please try again.",
    );
  }
  let data;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok)
    throw new ApiError(
      res.status,
      data?.error?.code || `HTTP_${res.status}`,
      data?.error?.message || "Request failed.",
    );
  return data;
}
async function api(method, path, body, options) {
  try {
    return await request(method, path, body, options);
  } catch (e) {
    if (
      ["KEY_REQUIRED", "KEY_EXPIRED", "SESSION_REQUIRED"].includes(e.code) &&
      path !== "/api/bootstrap"
    ) {
      await bootstrap();
      return request(method, path, body, options);
    }
    throw e;
  }
}
function bootstrap() {
  if (state.booting) return state.booting;
  state.booting = (async () => {
    const s = await request("GET", "/api/session");
    state.csrf = s.csrf_token;
    let result;
    try {
      result = await request("POST", "/api/bootstrap", {});
    } catch (e) {
      if (e.code !== "APP_MISMATCH" || state.current) throw e;
      await request("POST", "/api/session/reset", {});
      const fresh = await request("GET", "/api/session");
      state.csrf = fresh.csrf_token;
      result = await request("POST", "/api/bootstrap", {});
    }
    state.csrf = result.session.csrf_token;
    state.inquiry = result.session.inquiry;
    state.mediaEnabled = result.session.media_enabled !== false;
    state.product = result.product;
    renderProduct();
    return result;
  })().finally(() => {
    state.booting = null;
  });
  return state.booting;
}
async function loadPage() {
  showError($("page-error"), null);
  $("retry-page").hidden = true;
  $("contact").disabled = true;
  $("product").setAttribute("aria-busy", "true");
  try {
    const r = await bootstrap();
    if (r.conversation) await selectConversation(r.conversation);
    $("contact").disabled = false;
  } catch (e) {
    showError($("page-error"), e);
    $("retry-page").hidden = false;
    $("title").textContent = "Product unavailable";
    $("photo-placeholder-text").textContent = "Unable to load product";
    $("photo-placeholder").querySelector(".loading-mark").hidden = true;
  } finally {
    $("product").setAttribute("aria-busy", "false");
  }
}
function renderProduct() {
  const p = state.product;
  $("title").textContent = p.title;
  $("price").textContent = p.price_label || "";
  $("price").hidden = !p.price_label;
  $("seller").textContent = p.seller || "";
  $("seller-row").hidden = !p.seller;
  $("channel").textContent = p.channel === "1688" ? "1688" : "Taobao";
  $("channel").hidden = false;
  const url = safeProductUrl(p.url);
  if (url) $("product-link").href = url;
  else $("product-link").removeAttribute("href");
  $("product-link").hidden = !url;
  const images = p.images.map(safeCdn).filter(Boolean);
  clear($("thumbnails"));
  function choose(src, index) {
    $("photo").src = src;
    $("photo").hidden = false;
    $("photo").alt = `${p.title} — photo ${index + 1}`;
    $("photo-placeholder").hidden = true;
    $("photo-count").textContent = `${index + 1} / ${images.length}`;
    $("photo-count").hidden = false;
    [...$("thumbnails").children].forEach((b, i) => {
      b.classList.toggle("selected", i === index);
      b.setAttribute("aria-pressed", String(i === index));
    });
  }
  images.forEach((src, i) =>
    $("thumbnails").append(
      el(
        "button",
        {
          type: "button",
          "aria-label": `Product photo ${i + 1}`,
          onclick: () => choose(src, i),
        },
        el("img", { src, alt: "", loading: "lazy" }),
      ),
    ),
  );
  if (images.length) {
    choose(images[0], 0);
  } else {
    $("photo-placeholder-text").textContent = "No product photo";
    $("photo-placeholder").querySelector(".loading-mark").hidden = true;
    $("photo-placeholder").hidden = false;
    $("photo").hidden = true;
    $("photo-count").hidden = true;
  }
  syncLauncher();
}
function inquiryReady() {
  const q = state.inquiry;
  return !!(q && q.enabled && q.mapped && q.read && q.write);
}
function canCompose() {
  return !!(
    state.current?.ready &&
    inquiryReady() &&
    state.current.status !== "closed" &&
    !state.connecting
  );
}
function openChat() {
  if ($("chat").hidden) state.returnFocus = document.activeElement;
  $("chat").hidden = false;
  $("contact").setAttribute("aria-expanded", "true");
  syncChatLayout();
  syncLauncher();
  scrollToLatest();
  $("hide-chat").focus({ preventScroll: true });
}
function hideChat() {
  $("chat").hidden = true;
  $("contact").setAttribute("aria-expanded", "false");
  syncChatLayout();
  syncLauncher();
  const target = state.returnFocus;
  (target?.isConnected && !target.closest("#chat")
    ? target
    : $("chat-launcher")
  ).focus({ preventScroll: true });
}
function syncLauncher() {
  const count = state.unread.size;
  $("chat-launcher").hidden = !state.product || !$("chat").hidden;
  $("chat-launcher").setAttribute("aria-expanded", String(!$("chat").hidden));
  $("chat-launcher").setAttribute(
    "aria-label",
    `Open supplier inquiry${count ? `, ${count} unread messages` : ""}`,
  );
  $("launcher-label").textContent = state.current
    ? "Continue conversation"
    : "Ask a question";
  $("unread-count").textContent = count > 99 ? "99+" : String(count);
  $("unread-count").hidden = !count;
}
function syncChatLayout() {
  const modal = mobileLayout.matches && !$("chat").hidden;
  document.body.classList.toggle("chat-open", !$("chat").hidden);
  $("page-content").inert = modal;
  $("site-header").inert = modal;
  if (modal) $("chat").setAttribute("aria-modal", "true");
  else $("chat").removeAttribute("aria-modal");
  const viewport = window.visualViewport;
  if (viewport) {
    $("chat").style.setProperty("--chat-height", `${viewport.height}px`);
    $("chat").style.setProperty("--chat-top", `${viewport.offsetTop}px`);
  }
}
function scrollToLatest() {
  $("messages").scrollTop = $("messages").scrollHeight;
  state.pendingScroll = false;
  state.unread.clear();
  $("new-messages").hidden = true;
  syncLauncher();
}
function renderEmpty() {
  const ready = canCompose();
  $("chat-empty").hidden = state.messages.size > 0;
  $("empty-title").textContent =
    state.current?.status === "closed"
      ? "Conversation ended"
      : "Let's talk details.";
  $("empty-description").textContent = state.connecting
    ? "Connecting you with support…"
    : ready
      ? "Ask a question below. Our team will check the details with the supplier."
      : state.current?.status === "closed"
        ? "You can start a new inquiry whenever you're ready."
        : "You can explore the product while chat is unavailable.";
  $("suggestions").hidden = !ready;
}
function focusComposer() {
  if (canCompose() && !$("chat").hidden)
    $("composer-text").focus({ preventScroll: true });
}
function stopTimers() {
  for (const t of state.timers) clearInterval(t);
  state.timers = [];
}
function draftFor(id) {
  if (!state.drafts.has(id))
    state.drafts.set(id, {
      text: "",
      files: [],
      cmid: null,
      sig: null,
      sending: false,
      error: null,
    });
  return state.drafts.get(id);
}
async function contactSupplier(newGeneration = false) {
  openChat();
  if (state.connecting) return;
  if (state.current && !newGeneration) {
    renderHeader();
    focusComposer();
    return;
  }
  state.connecting = true;
  renderHeader();
  showError($("chat-error"), null);
  $("retry-chat").hidden = true;
  try {
    const r = await bootstrap();
    if (!inquiryReady())
      throw new ApiError(
        403,
        "INSUFFICIENT_SCOPE",
        "Inquiry access is not enabled.",
      );
    const result = await api("POST", "/api/conversations", {
      slot: state.product.slot,
      ...(newGeneration ? { new_generation: true } : {}),
    });
    await selectConversation(result.conversation);
    showError($("chat-error"), null);
  } catch (e) {
    showError($("chat-error"), e);
    $("retry-chat").hidden = false;
  } finally {
    state.connecting = false;
    renderHeader();
    focusComposer();
  }
}
async function selectConversation(conv) {
  if (!conv.ready) return;
  stopTimers();
  if (state.current) draftFor(state.current.id).text = $("composer-text").value;
  state.current = conv;
  const view = ++state.viewEpoch;
  state.messages = new Map();
  state.seq = 0;
  state.nextCursor = null;
  state.olderLoaded = false;
  state.historyReady = false;
  state.unread.clear();
  state.pendingScroll = false;
  $("composer-text").value = draftFor(conv.id).text;
  renderHeader();
  renderMessages();
  renderDraft();
  await reconcile(true);
  if (state.viewEpoch !== view) return;
  await pollUpdates();
  if (state.viewEpoch !== view) return;
  state.historyReady = true;
  if (!$("chat").hidden) scrollToLatest();
  syncLauncher();
  state.timers.push(
    setInterval(pollUpdates, 3000),
    setInterval(() => reconcile(false), 20000),
  );
}
function renderHeader() {
  const c = state.current,
    closed = c?.status === "closed",
    ready = canCompose();
  $("chat-status").textContent = state.connecting
    ? "Connecting…"
    : closed
      ? "Conversation ended"
      : c
        ? "Human support · Product inquiry"
        : "Human support";
  $("close-conv").hidden = !c || closed;
  $("close-conv").disabled = state.connecting;
  $("composer").hidden = !!closed;
  $("closed-panel").hidden = !closed;
  $("composer-text").disabled = !ready;
  $("attach").disabled = !ready || !state.mediaEnabled;
  $("attach").hidden = !state.mediaEnabled;
  $("attach").title = state.mediaEnabled
    ? "Attach images or video"
    : "This demo currently supports text messages only";
  renderEmpty();
  if (c) renderDraft();
  else $("send").disabled = true;
  if (closed) renderRating();
}
function setConversation(conv) {
  if (!conv || conv.id !== state.current?.id) return;
  const changed = conv.status !== state.current.status;
  state.current = conv;
  if (changed) renderHeader();
}
function mergeMessages(list, { historical = false } = {}) {
  let changed = false;
  let hasNewReply = false;
  for (const m of list || []) {
    const prev = state.messages.get(m.id);
    if (prev?.recalled_at) continue;
    if (m.recalled_at) state.unread.delete(m.id);
    if (
      !prev &&
      state.historyReady &&
      !historical &&
      m.sender_type === "staff"
      && !m.recalled_at
    ) {
      hasNewReply = true;
      state.pendingScroll = true;
      if ($("chat").hidden) state.unread.add(m.id);
    }
    if (
      !prev ||
      m.recalled_at !== prev.recalled_at ||
      prev.seq !== m.seq ||
      prev.arrival !== m.arrival ||
      prev.webhook_confirmed !== m.webhook_confirmed
    ) {
      state.messages.set(m.id, m);
      changed = true;
    }
  }
  if (hasNewReply) playReplySound();
  syncLauncher();
  return changed;
}
async function reconcile(initial) {
  const conv = state.current, view = state.viewEpoch, busy = `sync:${view}`;
  if (!conv || state.busy.has(busy)) return;
  state.busy.add(busy);
  try {
    const r = await api("GET", `/api/conversations/${conv.id}/messages`);
    if (state.current?.id !== conv.id || state.viewEpoch !== view) return;
    if (initial || !state.olderLoaded) state.nextCursor = r.next_cursor;
    setConversation(r.conversation);
    if (mergeMessages(r.messages) || initial) renderMessages();
    showError($("chat-error"), null);
  } catch (e) {
    if (state.current?.id === conv.id && state.viewEpoch === view) showError($("chat-error"), e);
  } finally {
    state.busy.delete(busy);
  }
}
async function pollUpdates() {
  const conv = state.current, view = state.viewEpoch, busy = `poll:${view}`;
  if (!conv || state.busy.has(busy)) return;
  state.busy.add(busy);
  try {
    const r = await api(
      "GET",
      `/api/conversations/${conv.id}/updates?since=${state.seq}`,
    );
    if (state.current?.id !== conv.id || state.viewEpoch !== view) return;
    state.seq = Math.max(state.seq, r.seq);
    setConversation(r.conversation);
    if (mergeMessages(r.messages)) renderMessages();
  } catch {
  } finally {
    state.busy.delete(busy);
  }
}
async function loadOlder() {
  if (!state.current || !state.nextCursor) return;
  $("load-older").disabled = true;
  const conv = state.current, view = state.viewEpoch;
  try {
    const r = await api(
      "GET",
      `/api/conversations/${conv.id}/messages?cursor=${encodeURIComponent(state.nextCursor)}`,
    );
    if (state.current?.id !== conv.id || state.viewEpoch !== view) return;
    state.olderLoaded = true;
    state.nextCursor = r.next_cursor;
    mergeMessages(r.messages, { historical: true });
    renderMessages(true);
  } catch (e) {
    if (state.viewEpoch === view) showError($("chat-error"), e);
  } finally {
    if (state.viewEpoch === view) $("load-older").disabled = false;
  }
}
function renderAttachment(a) {
  const path = safeLocalPath(a.content_path);
  if (!path) return null;
  const box = el("div", { class: "att" });
  if (a.content_type.startsWith("image/"))
    box.append(el("img", { src: path, alt: a.filename, loading: "lazy" }));
  else
    box.append(el("video", { src: path, controls: true, preload: "metadata" }));
  box.append(
    el("a", {
      href: `${path}?download=1`,
      download: a.filename,
      text: `Download ${a.filename}`,
    }),
  );
  return box;
}
function renderMessages(keepScroll = false) {
  const wrap = $("messages"),
    list = $("message-list"),
    atBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 60,
    prevHeight = wrap.scrollHeight;
  clear(list);
  const msgs = [...state.messages.values()].sort(
    (a, b) =>
      a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  );
  renderEmpty();
  for (const m of msgs) {
    const mine = m.sender_type === "customer",
      li = el("li", { class: `msg ${mine ? "customer" : "staff"}` });
    li.append(
      el("span", { class: "who", text: mine ? "You" : "Supplier support" }),
    );
    if (m.recalled_at) {
      li.classList.add("recalled");
      li.append(el("div", { class: "bubble", text: "This message was recalled." }));
    }
    if (!m.recalled_at && m.product_card) {
      li.append(
        el(
          "div",
          { class: "card-link" },
          el("div", { class: "cs", text: "I'm looking at this product" }),
          el("div", { class: "ct", text: m.product_card.title }),
          m.product_card.price_label
            ? el("div", { class: "cs", text: m.product_card.price_label })
            : null,
        ),
      );
    }
    if (!m.recalled_at && m.content) li.append(el("div", { class: "bubble", text: m.content }));
    if (!m.recalled_at && m.attachments?.length)
      li.append(
        el("div", { class: "atts" }, m.attachments.map(renderAttachment)),
      );
    li.append(el("div", { class: "meta", text: fmtTime(m.created_at) }));
    list.append(li);
  }
  $("load-older").hidden = !state.nextCursor;
  if (keepScroll) wrap.scrollTop = wrap.scrollHeight - prevHeight;
  else if (atBottom && !$("chat").hidden) scrollToLatest();
  else if (state.pendingScroll && !$("chat").hidden)
    $("new-messages").hidden = false;
}
function renderDraft() {
  if (!state.current) return;
  const input = $("composer-text");
  input.style.height = "auto";
  input.style.height = `${Math.min(136, Math.max(40, input.scrollHeight))}px`;
  const d = draftFor(state.current.id);
  const ul = $("draft-files");
  clear(ul);
  for (const f of d.files) {
    const li = el("li", {
      class: `draft-file${f.status === "error" ? " error" : ""}`,
    });
    const path = f.attachment && safeLocalPath(f.attachment.content_path);
    if (path && f.attachment.content_type.startsWith("image/"))
      li.append(el("img", { src: path, alt: "" }));
    li.append(
      el("span", {
        class: "name",
        text: f.file.name || f.file.type,
        title: f.file.name,
      }),
    );
    li.append(
      el("span", {
        class: "muted",
        text:
          f.status === "uploaded"
            ? "Ready"
            : f.status === "uploading"
              ? "uploading…"
              : f.status === "error"
                ? (f.error ?? "failed")
                : "queued",
      }),
    );
    if (f.status === "error")
      li.append(
        el("button", {
          type: "button",
          text: "Retry",
          onclick: () => uploadFile(state.current.id, f),
        }),
      );
    if (f.status !== "uploading" && !d.sending)
      li.append(
        el("button", {
          type: "button",
          text: "✕",
          title: "Remove",
          onclick: () => {
            d.files = d.files.filter((x) => x !== f);
            renderDraft();
          },
        }),
      );
    ul.append(li);
  }
  $("send").disabled =
    d.sending ||
    !canCompose() ||
    (!$("composer-text").value.trim() && !d.files.length);
  const st = $("send-status");
  st.className = `send-status${d.error ? " err" : ""}`;
  st.textContent = d.sending
    ? "Sending…"
    : d.error
      ? `${friendlyError(d.error)} — press Send to retry`
      : "";
}
function videoDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      v.onloadedmetadata = null;
      v.onerror = null;
      v.removeAttribute("src");
      v.load();
      URL.revokeObjectURL(url);
      resolve(val);
    };
    v.preload = "metadata";
    v.onloadedmetadata = () => done(v.duration);
    v.onerror = () => done(null);
    const timer = setTimeout(() => done(null), 8000);
    v.src = url;
  });
}
async function addFiles(fileList) {
  if (!state.current) return;
  if (!state.mediaEnabled) {
    showError($("chat-error"), {
      message: "This demo currently supports text messages only.",
    });
    return;
  }
  const convId = state.current.id;
  const d = draftFor(convId);
  for (const file of fileList) {
    if (d.files.length >= 4) {
      d.error = {
        code: "TOO_MANY_ATTACHMENTS",
        message: "At most 4 images/videos per message.",
      };
      break;
    }
    if (!(file.type in MEDIA)) {
      d.error = {
        code: "UNSUPPORTED_TYPE",
        message: `${file.name || "File"}: use PNG, JPEG, WebP or MP4.`,
      };
      continue;
    }
    if (file.size > MEDIA[file.type] || file.size === 0) {
      d.error = {
        code: "FILE_TOO_LARGE",
        message: `${file.name || "File"} exceeds ${file.type === "video/mp4" ? "20" : "10"} MiB.`,
      };
      continue;
    }
    if (file.type === "video/mp4") {
      const dur = await videoDuration(file);
      if (dur !== null && dur > 120) {
        d.error = {
          code: "VIDEO_TOO_LONG",
          message: `${file.name || "Video"} is longer than 120 seconds.`,
        };
        continue;
      }
    }
    const f = {
      file,
      uploadId: crypto.randomUUID(),
      status: "queued",
      attachment: null,
      error: null,
    };
    d.files.push(f);
    uploadFile(convId, f);
  }
  if (state.current?.id === convId) renderDraft();
}
async function uploadFile(convId, f) {
  if (f.status === "uploading" || f.status === "uploaded") return;
  f.status = "uploading";
  f.error = null;
  if (state.current?.id === convId) renderDraft();
  try {
    const headers = { "Content-Type": f.file.type };
    if (f.file.name)
      headers["X-Filename"] = encodeURIComponent(f.file.name.slice(0, 128));
    const r = await api(
      "POST",
      `/api/conversations/${convId}/attachments?upload_id=${f.uploadId}`,
      undefined,
      { raw: f.file, headers },
    );
    f.attachment = r.attachment;
    f.status = "uploaded";
  } catch (e) {
    f.status = "error";
    f.error = `${e.code}`;
  }
  if (state.current?.id === convId) renderDraft();
}
async function send(ev) {
  ev?.preventDefault();
  const conv = state.current;
  if (!conv || !canCompose()) return;
  const d = draftFor(conv.id);
  if (d.sending) return;
  // Exact original text (whitespace/newlines kept); trim only for the blank check.
  const raw = $("composer-text").value;
  const text = raw.trim() ? raw : "";
  const files = d.files.slice();
  if (!text && !files.length) return;
  if (files.some((f) => f.status !== "uploaded")) {
    d.error = {
      code: "UPLOAD_PENDING",
      message: files.some((f) => f.status === "error")
        ? "Retry or remove failed uploads first."
        : "Wait for uploads to finish.",
    };
    return renderDraft();
  }
  const attachmentIds = files.map((f) => f.attachment.id);
  const sig = JSON.stringify([text, attachmentIds]);
  if (!d.cmid || d.sig !== sig) {
    d.cmid = crypto.randomUUID();
    d.sig = sig;
  } // stable across retries of the same payload
  d.sending = true;
  d.error = null;
  renderDraft();
  const body = { client_message_id: d.cmid };
  if (text) body.content = text;
  if (attachmentIds.length) body.attachment_ids = attachmentIds;
  try {
    const { message } = await api(
      "POST",
      `/api/conversations/${conv.id}/messages`,
      body,
    );
    // Clear only what was actually sent; newer edits/files stay in the draft.
    const sentIds = new Set(attachmentIds);
    d.files = d.files.filter(
      (f) => !(f.attachment && sentIds.has(f.attachment.id)),
    );
    // Clear only the exact sent draft; any newer edit (even whitespace) is kept.
    if (state.current?.id === conv.id) {
      if ($("composer-text").value === raw) $("composer-text").value = "";
      d.text = $("composer-text").value;
    } else if (d.text === raw) d.text = "";
    d.cmid = null;
    d.sig = null;
    if (state.current?.id === conv.id && mergeMessages([message])) {
      renderMessages();
      if (!$("chat").hidden) scrollToLatest();
    }
  } catch (e) {
    d.error = e;
  } finally {
    d.sending = false;
    if (state.current?.id === conv.id) renderDraft();
  }
}

async function renderRating() {
  const box = $("rating-panel");
  clear(box);
  const conv = state.current;
  if (state.skippedRating.has(conv.id)) {
    box.append(el("p", { class: "muted small", text: "Rating skipped." }));
    return;
  }
  let s;
  try {
    s = await api("GET", `/api/conversations/${conv.id}/rating`);
  } catch (e) {
    box.append(el("p", { class: "error", text: friendlyError(e) }));
    return;
  }
  if (state.current?.id !== conv.id) return;
  clear(box);
  if (s.status === "submitted" && s.rating) {
    box.append(
      el("p", {
        text: `Thanks — you rated ${s.rating.rating}★${s.rating.comment ? `: “${s.rating.comment}”` : ""}`,
      }),
    );
    return;
  }
  if (s.status === "expired") {
    box.append(
      el("p", {
        class: "muted small",
        text: "The 7-day rating window has ended.",
      }),
    );
    return;
  }
  if (s.status !== "available") {
    box.append(
      el("p", {
        class: "muted small",
        text: `Rating unavailable (${s.status}).`,
      }),
    );
    return;
  }
  let value = 0;
  const stars = el("div", {
    class: "stars",
    role: "group",
    "aria-label": "Rating",
  });
  const btns = [1, 2, 3, 4, 5].map((n) =>
    el("button", {
      type: "button",
      text: "★",
      "aria-label": `${n} star${n > 1 ? "s" : ""}`,
      onclick: () => {
        value = n;
        btns.forEach((b, i) => {
          b.classList.toggle("on", i < n);
          b.setAttribute("aria-pressed", String(i < n));
        });
        submit.disabled = false;
      },
    }),
  );
  stars.append(...btns);
  const comment = el("textarea", {
    rows: 2,
    maxLength: 1000,
    placeholder: "Optional comment (max 1000 characters)",
  });
  const err = el("p", { class: "error", hidden: true });
  const submit = el("button", {
    type: "button",
    class: "primary",
    text: "Submit rating",
    disabled: true,
  });
  const skip = el("button", {
    type: "button",
    text: "Skip",
    onclick: () => {
      state.skippedRating.add(conv.id);
      renderRating();
    },
  });
  submit.addEventListener("click", async () => {
    if (!value || submit.disabled) return;
    submit.disabled = true;
    try {
      const body = { rating: value };
      const c = comment.value.trim();
      if (c) body.comment = c;
      await api("POST", `/api/conversations/${conv.id}/rating`, body);
      renderRating();
    } catch (e) {
      showError(err, e);
      submit.disabled = false;
    }
  });
  box.append(
    el("p", { text: `How was your support experience?` }),
    stars,
    comment,
    el("div", { class: "row" }, submit, skip),
    err,
  );
}

async function closeConversation() {
  const c = state.current;
  if (!c || !canCompose()) return;
  const b = $("close-conv");
  if (b.dataset.confirm !== "1") {
    b.dataset.confirm = "1";
    b.textContent = "Confirm end";
    setTimeout(() => {
      b.dataset.confirm = "";
      b.textContent = "End chat";
    }, 5000);
    return;
  }
  b.disabled = true;
  try {
    const { conversation } = await api(
      "POST",
      `/api/conversations/${c.id}/close`,
      {},
    );
    setConversation(conversation);
  } catch (e) {
    showError($("chat-error"), e);
  } finally {
    b.disabled = false;
    b.dataset.confirm = "";
    b.textContent = "End chat";
  }
}
$("contact").addEventListener("click", () => contactSupplier());
$("retry-chat").addEventListener("click", () => contactSupplier());
$("retry-page").addEventListener("click", loadPage);
$("chat-launcher").addEventListener("click", () => contactSupplier());
$("reply-sound").addEventListener("click", () => {
  state.soundEnabled = !state.soundEnabled;
  $("reply-sound").setAttribute("aria-pressed", String(state.soundEnabled));
  $("reply-sound").setAttribute(
    "aria-label",
    state.soundEnabled ? "Mute reply sound" : "Enable reply sound",
  );
  $("reply-sound").title = state.soundEnabled
    ? "Reply sound on"
    : "Reply sound off";
  unlockReplySound();
});
document.addEventListener("pointerdown", unlockReplySound, { passive: true });
document.addEventListener("keydown", unlockReplySound);
$("hide-chat").addEventListener("click", hideChat);
$("new-messages").addEventListener("click", scrollToLatest);
$("messages").addEventListener(
  "scroll",
  () => {
    const wrap = $("messages");
    if (wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 60) {
      state.pendingScroll = false;
      $("new-messages").hidden = true;
    }
  },
  { passive: true },
);
$("suggestions").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-question]");
  if (!button || !canCompose()) return;
  // Suggestions only fill an empty draft; the visitor decides when to send.
  if (!$("composer-text").value.trim()) {
    $("composer-text").value = button.dataset.question;
    draftFor(state.current.id).text = button.dataset.question;
    renderDraft();
  }
  focusComposer();
});
$("composer").addEventListener("submit", send);
$("composer-text").addEventListener("input", () => {
  if (state.current) draftFor(state.current.id).text = $("composer-text").value;
  renderDraft();
});
$("composer-text").addEventListener("keydown", (e) => {
  if (
    e.key === "Enter" &&
    !e.shiftKey &&
    !e.isComposing &&
    !mobileLayout.matches
  ) {
    e.preventDefault();
    send(e);
  }
});
$("composer-text").addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files || [])].filter(
    (f) => f.type in MEDIA,
  );
  if (files.length) {
    if (!e.clipboardData.types.includes("text/plain")) e.preventDefault();
    addFiles(files);
  }
});
$("attach").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", (e) => {
  addFiles([...e.target.files]);
  e.target.value = "";
});
$("load-older").addEventListener("click", loadOlder);
$("close-conv").addEventListener("click", closeConversation);
$("new-generation").addEventListener("click", () => contactSupplier(true));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("chat").hidden) $("hide-chat").click();
  if (e.key === "Tab" && mobileLayout.matches && !$("chat").hidden) {
    const targets = [
      ...$("chat").querySelectorAll(
        "button:not(:disabled), a[href], textarea:not(:disabled), [tabindex='0']",
      ),
    ].filter((node) => node.getClientRects().length);
    const first = targets[0],
      last = targets[targets.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  }
});
mobileLayout.addEventListener("change", syncChatLayout);
window.visualViewport?.addEventListener("resize", syncChatLayout);
window.visualViewport?.addEventListener("scroll", syncChatLayout);
if (window.ResizeObserver) {
  const composerSize = new ResizeObserver(() => {
    const panel = $("composer").hidden ? $("closed-panel") : $("composer");
    $("chat").style.setProperty(
      "--composer-height",
      `${panel.getBoundingClientRect().height}px`,
    );
  });
  composerSize.observe($("composer"));
  composerSize.observe($("closed-panel"));
}
loadPage();
