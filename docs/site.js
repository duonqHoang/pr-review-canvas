const VI_TEXT = {
  "Skip to content": "Bỏ qua để đến nội dung",
  "Primary navigation": "Điều hướng chính",
  "pr-review-canvas home": "Trang chủ pr-review-canvas",
  "How it works": "Cách hoạt động",
  Docs: "Tài liệu",
  "Get started": "Bắt đầu",
  Language: "Ngôn ngữ",
  "Open source · npm": "Mã nguồn mở · npm",
  "You review.": "Bạn review.",
  "Your agent assists.": "Agent phụ một tay.",
  "A local, GitHub-style diff canvas where you inspect every line, ask your coding agent questions inline, and submit the review you wrote—unchanged.":
    "Mở diff trong một giao diện quen thuộc như GitHub, hỏi agent ngay bên cạnh đoạn code đang đọc, rồi tự tay gửi review của mình.",
  "Start reviewing": "Bắt đầu review",
  "View on GitHub": "Xem trên GitHub",
  "The boundary is the product.": "Bạn quyết định, agent chỉ hỗ trợ.",
  "The agent can answer and relay. It cannot write or approve your review.":
    "Agent trả lời câu hỏi và gửi giúp review đã được bạn duyệt. Agent không thể tự viết hay tự approve.",
  "Illustration of the pull request review canvas": "Minh họa canvas review pull request",
  "Fix anchor validation": "Sửa logic kiểm tra anchor",
  "4 files changed": "4 file thay đổi",
  "2 drafts": "2 bản nháp",
  "Files changed": "Các file thay đổi",
  You: "Bạn",
  "asked your agent": "đã hỏi agent",
  "Why validate commentability again here?": "Tại sao phải kiểm tra lại khả năng comment ở đây?",
  "The diff may have changed since the draft was created. This keeps a stale anchor out of the atomic batch.":
    "Diff có thể đã đổi sau khi bạn tạo bản nháp. Kiểm tra lại ở đây để comment không bị gửi nhầm sang code cũ.",
  "Write comment": "Viết comment",
  "Install the skill": "Cài skill",
  "One command. No global install.": "Chạy một lệnh là xong.",
  "Copy install command": "Sao chép lệnh cài đặt",
  Copy: "Sao chép",
  Copied: "Đã chép",
  "Select text": "Chọn văn bản",
  "Requires Node 22+ and an authenticated": "Cần Node 22+ và",
  "CLI.": "CLI đã đăng nhập.",
  "Three participants.": "Ba thành phần.",
  "One durable review.": "Review không lo bị mất.",
  "The browser and agent never trade hidden state. A local server keeps the review coherent—even if a tab closes or an agent stops.":
    "Browser và agent đều làm việc qua một local server. Nhờ vậy, review vẫn còn nguyên nếu bạn lỡ đóng tab hoặc agent dừng giữa chừng.",
  "You read the diff": "Bạn đọc diff",
  "Open any PR in a local browser canvas. Navigate by line, hunk, or file and draft every review comment yourself.":
    "Mở PR ngay trên máy, đọc diff theo dòng, hunk hoặc file. Mọi review comment vẫn do chính bạn viết.",
  "Your agent answers": "Agent trả lời",
  "Highlight any visible line and ask a question. The agent receives a capped code excerpt; its answer appears inline without a reload.":
    "Bôi đen dòng đang thắc mắc rồi hỏi. Agent chỉ nhận phần code liên quan và câu trả lời hiện ngay bên dưới, không cần reload.",
  "Your review ships": "Bạn duyệt rồi mới gửi",
  "You inspect the final verdict, summary, and comments. Submit arms one exact payload; the agent relays it in one atomic call.":
    "Bạn xem lại kết luận, phần tổng kết và từng comment. Khi bấm Submit, agent chỉ gửi đúng nội dung bạn vừa duyệt, trong một lần duy nhất.",
  "Built for the hard parts": "Giữ an toàn cho phần quan trọng nhất",
  "Your words stay yours.": "Review của bạn vẫn là của bạn.",
  "Review prose is too valuable to risk on a refresh, a process crash, or an over-helpful agent. The system is shaped around that fact.":
    "Không ai muốn mất nửa tiếng viết review chỉ vì refresh trang, process bị crash hay agent tự ý sửa câu chữ. Tool này được xây để chuyện đó không xảy ra.",
  "Read the design rationale": "Xem vì sao tool được thiết kế như vậy",
  "Journaled before it is rendered": "Bản nháp được lưu ngay lập tức",
  "Every draft edit reaches an append-only journal before the fold cache changes. A torn final write is safely ignored.":
    "Mỗi lần bạn sửa comment, nội dung được ghi vào nhật ký trước rồi giao diện mới cập nhật. Nếu process dừng giữa chừng, bản nháp vẫn an toàn.",
  "No agent-authored reviews": "Agent không thể tự review thay bạn",
  "There is no command for the agent to comment, approve, or request changes. Findings stay evidence—not review prose.":
    "Không có câu lệnh nào cho phép agent tự comment, approve hay request changes. Agent chỉ có thể đưa ra phát hiện để bạn cân nhắc.",
  "Refresh proposes; never moves": "Code đổi thì hỏi lại bạn",
  "After a push, uncertain anchors become stale proposals. Nothing moves onto code you did not review.":
    "Khi PR có commit mới, tool sẽ đề xuất vị trí mới cho comment. Chỉ khi bạn xác nhận thì comment mới được chuyển—không bao giờ tự gắn vào code bạn chưa đọc.",
  "Single-use, memory-only submit token": "Mỗi lần submit dùng một token riêng",
  "The token is bound to the payload you approved, expires in ten minutes, and is consumed before GitHub is called.":
    "Token chỉ dùng được cho đúng nội dung bạn vừa duyệt, tự hết hạn sau mười phút và không thể dùng lại để gửi trùng.",
  "Quick reference": "Tham khảo nhanh",
  "From first PR to release train.": "Review một PR hay cả release train.",
  "Start with one pull request. Add a workspace when several changes need to land together.":
    "Bắt đầu với một PR. Khi cần theo dõi nhiều PR cùng lúc, gom chúng vào một workspace.",
  "Documentation topics": "Chủ đề tài liệu",
  "Quick start": "Bắt đầu nhanh",
  "Ask questions": "Đặt câu hỏi",
  Workspaces: "Workspace",
  Keyboard: "Bàn phím",
  "Open a pull request": "Mở một pull request",
  "Use a number inside its repository, a canonical reference from anywhere, or a full GitHub URL.":
    "Đang đứng trong repo thì chỉ cần nhập số PR. Ở chỗ khác, dùng owner/repo#số hoặc dán thẳng URL GitHub.",
  "Inline Q&A": "Hỏi đáp tại chỗ",
  "Ask about what you can see": "Hỏi ngay trên dòng code đang đọc",
  "Select any displayed line—including context and expanded lines—then press":
    "Chọn dòng bất kỳ đang hiện trên màn hình—kể cả dòng context hoặc dòng vừa mở rộng—rồi nhấn",
  "Asking and commenting are deliberately separate actions.":
    "Hỏi agent và viết review comment là hai việc riêng biệt.",
  ". Asking and commenting are deliberately separate actions.":
    ". Hỏi agent và viết review comment là hai việc riêng biệt.",
  "Coordinate a release train": "Theo dõi nhiều PR trong một workspace",
  "A workspace orders attention across PRs without merging their state or weakening the per-review submission gate.":
    "Workspace giúp bạn biết PR nào cần xem trước, nhưng mỗi PR vẫn giữ diff, bản nháp và bước submit riêng.",
  "Stay in the diff": "Review mà không cần rời bàn phím",
  Line: "Dòng",
  File: "File",
  Hunk: "Hunk",
  "Filter files": "Lọc file",
  Comment: "Comment",
  "All shortcuts": "Tất cả phím tắt",
  "Keep the judgment human": "Quyết định cuối cùng vẫn là của bạn",
  "Read every line.": "Đọc kỹ từng dòng.",
  "Ask better questions.": "Để agent phụ phần còn lại.",
  "Install pr-review-canvas": "Cài pr-review-canvas",
  "MIT licensed · Runs locally · GitHub via": "MIT · Chạy ngay trên máy · Kết nối GitHub qua",
  "Independent open-source project. Not affiliated with or endorsed by GitHub, Inc.":
    "Dự án mã nguồn mở độc lập, không thuộc GitHub, Inc.",
  Source: "Mã nguồn",
};

const PAGE_META = {
  en: {
    title: "pr-review-canvas — Review with your agent, not through it",
    description:
      "Review GitHub pull requests with your coding agent in a local, durable, human-controlled diff canvas.",
  },
  vi: {
    title: "pr-review-canvas — Bạn review, agent phụ một tay",
    description:
      "Đọc diff, hỏi agent ngay trên dòng code và tự tay gửi review của bạn—tất cả trong một giao diện chạy ngay trên máy.",
  },
};

const originalText = new WeakMap();
const originalAttributes = new WeakMap();

function textKey(value) {
  return value.replace(/\s+/g, " ").trim();
}

function translatedNodeValue(source, translated) {
  const leading = source.match(/^\s*/)?.[0] ?? "";
  const trailing = source.match(/\s*$/)?.[0] ?? "";
  return `${leading}${translated}${trailing}`;
}

function translatePage(language) {
  document.documentElement.lang = language;
  document.title = PAGE_META[language].title;
  document.querySelector('meta[name="description"]')?.setAttribute("content", PAGE_META[language].description);
  document.querySelector('meta[property="og:description"]')?.setAttribute("content", PAGE_META[language].description);

  for (const element of document.querySelectorAll("body *")) {
    if (element.closest("code, pre, kbd, script, style, option")) continue;
    if (element.childNodes.length !== 1 || element.firstChild?.nodeType !== Node.TEXT_NODE) continue;
    const node = element.firstChild;
    if (!originalText.has(node)) originalText.set(node, node.nodeValue);
    const source = originalText.get(node);
    const key = textKey(source);
    const translated = language === "vi" ? VI_TEXT[key] : null;
    node.nodeValue = translated ? translatedNodeValue(source, translated) : source;
  }

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.parentElement?.closest("code, pre, kbd, script, style, option")) continue;
    if (!originalText.has(node)) originalText.set(node, node.nodeValue);
    const source = originalText.get(node);
    const key = textKey(source);
    if (!key) continue;
    const translated = language === "vi" ? VI_TEXT[key] : null;
    node.nodeValue = translated ? translatedNodeValue(source, translated) : source;
  }

  for (const element of document.querySelectorAll("[aria-label]")) {
    if (!originalAttributes.has(element)) originalAttributes.set(element, element.getAttribute("aria-label"));
    const source = originalAttributes.get(element);
    element.setAttribute("aria-label", language === "vi" && VI_TEXT[source] ? VI_TEXT[source] : source);
  }
}

const languageSelect = document.querySelector(".language-picker select");
const requestedLanguage = new URLSearchParams(window.location.search).get("lang");
const savedLanguage = window.localStorage.getItem("prc-language");
const initialLanguage =
  requestedLanguage === "vi" || requestedLanguage === "en" ? requestedLanguage : savedLanguage === "vi" ? "vi" : "en";

if (languageSelect) {
  languageSelect.value = initialLanguage;
  translatePage(initialLanguage);
  languageSelect.addEventListener("change", () => {
    const language = languageSelect.value === "vi" ? "vi" : "en";
    window.localStorage.setItem("prc-language", language);
    const url = new URL(window.location.href);
    if (language === "en") url.searchParams.delete("lang");
    else url.searchParams.set("lang", language);
    window.history.replaceState(null, "", url);
    translatePage(language);
  });
}

const copyButton = document.querySelector("[data-copy]");

copyButton?.addEventListener("click", async () => {
  const command = copyButton.getAttribute("data-copy");
  const label = copyButton.querySelector("span");
  if (!command || !label) return;

  try {
    await navigator.clipboard.writeText(command);
    label.textContent = document.documentElement.lang === "vi" ? VI_TEXT.Copied : "Copied";
    window.setTimeout(() => {
      label.textContent = document.documentElement.lang === "vi" ? VI_TEXT.Copy : "Copy";
    }, 1800);
  } catch {
    const commandText = document.querySelector(".command-wrap code");
    const selection = window.getSelection();
    if (commandText && selection) {
      const range = document.createRange();
      range.selectNodeContents(commandText);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    label.textContent = document.documentElement.lang === "vi" ? VI_TEXT["Select text"] : "Select text";
  }
});

const docLinks = [...document.querySelectorAll(".docs-nav a")];
const docSections = docLinks
  .map((link) => document.querySelector(link.getAttribute("href")))
  .filter((section) => section != null);

if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      const current = entries.find((entry) => entry.isIntersecting);
      if (!current) return;
      for (const link of docLinks) {
        link.classList.toggle("active", link.hash === `#${current.target.id}`);
      }
    },
    { rootMargin: "-20% 0px -65%", threshold: 0 },
  );
  for (const section of docSections) observer.observe(section);
}
