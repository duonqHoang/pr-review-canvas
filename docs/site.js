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
  "Your agent assists.": "Agent hỗ trợ.",
  "A local, GitHub-style diff canvas where you inspect every line, ask your coding agent questions inline, and submit the review you wrote—unchanged.":
    "Một canvas diff kiểu GitHub chạy cục bộ, nơi bạn đọc từng dòng, hỏi coding agent ngay tại đoạn code và gửi nguyên vẹn review do chính bạn viết.",
  "Start reviewing": "Bắt đầu review",
  "View on GitHub": "Xem trên GitHub",
  "The boundary is the product.": "Ranh giới chính là sản phẩm.",
  "The agent can answer and relay. It cannot write or approve your review.":
    "Agent có thể trả lời và chuyển tiếp. Agent không thể viết hoặc phê duyệt review thay bạn.",
  "Illustration of the pull request review canvas": "Minh họa canvas review pull request",
  "Fix anchor validation": "Sửa kiểm tra anchor",
  "4 files changed": "4 file thay đổi",
  "2 drafts": "2 bản nháp",
  "Files changed": "Các file thay đổi",
  You: "Bạn",
  "asked your agent": "đã hỏi agent",
  "Why validate commentability again here?": "Tại sao phải kiểm tra lại khả năng comment ở đây?",
  "The diff may have changed since the draft was created. This keeps a stale anchor out of the atomic batch.":
    "Diff có thể đã thay đổi từ lúc tạo bản nháp. Việc này ngăn anchor cũ lọt vào batch nguyên tử.",
  "Write comment": "Viết comment",
  "Install the skill": "Cài skill",
  "One command. No global install.": "Một lệnh. Không cần cài global.",
  "Copy install command": "Sao chép lệnh cài đặt",
  Copy: "Sao chép",
  Copied: "Đã chép",
  "Select text": "Chọn văn bản",
  "Requires Node 22+ and an authenticated": "Cần Node 22+ và",
  "CLI.": "CLI đã đăng nhập.",
  "Three participants.": "Ba bên tham gia.",
  "One durable review.": "Một review bền vững.",
  "The browser and agent never trade hidden state. A local server keeps the review coherent—even if a tab closes or an agent stops.":
    "Browser và agent không trao đổi trạng thái ẩn. Local server giữ review nhất quán—ngay cả khi tab đóng hoặc agent dừng.",
  "You read the diff": "Bạn đọc diff",
  "Open any PR in a local browser canvas. Navigate by line, hunk, or file and draft every review comment yourself.":
    "Mở PR bất kỳ trong canvas trên browser cục bộ. Di chuyển theo dòng, hunk hoặc file và tự viết từng review comment.",
  "Your agent answers": "Agent trả lời",
  "Highlight any visible line and ask a question. The agent receives a capped code excerpt; its answer appears inline without a reload.":
    "Chọn một dòng đang hiển thị và đặt câu hỏi. Agent nhận đoạn code được giới hạn; câu trả lời xuất hiện tại chỗ mà không reload.",
  "Your review ships": "Review được gửi đi",
  "You inspect the final verdict, summary, and comments. Submit arms one exact payload; the agent relays it in one atomic call.":
    "Bạn kiểm tra verdict, phần tóm tắt và comment cuối cùng. Submit khóa đúng một payload; agent chuyển tiếp bằng một lệnh gọi nguyên tử.",
  "Built for the hard parts": "Dành cho phần khó nhất",
  "Your words stay yours.": "Lời của bạn vẫn là của bạn.",
  "Review prose is too valuable to risk on a refresh, a process crash, or an over-helpful agent. The system is shaped around that fact.":
    "Nội dung review quá giá trị để đánh cược với refresh, process crash hay một agent quá nhiệt tình. Hệ thống được thiết kế quanh sự thật đó.",
  "Read the design rationale": "Đọc lý do thiết kế",
  "Journaled before it is rendered": "Ghi journal trước khi render",
  "Every draft edit reaches an append-only journal before the fold cache changes. A torn final write is safely ignored.":
    "Mỗi chỉnh sửa bản nháp được ghi vào journal append-only trước khi cache thay đổi. Lần ghi cuối bị lỗi sẽ được bỏ qua an toàn.",
  "No agent-authored reviews": "Agent không thể viết review",
  "There is no command for the agent to comment, approve, or request changes. Findings stay evidence—not review prose.":
    "Không có lệnh để agent comment, approve hay request changes. Findings chỉ là bằng chứng—không phải nội dung review.",
  "Refresh proposes; never moves": "Refresh chỉ đề xuất; không tự di chuyển",
  "After a push, uncertain anchors become stale proposals. Nothing moves onto code you did not review.":
    "Sau một lần push, anchor không chắc chắn trở thành đề xuất stale. Không nội dung nào tự chuyển sang code bạn chưa review.",
  "Single-use, memory-only submit token": "Submit token dùng một lần, chỉ nằm trong bộ nhớ",
  "The token is bound to the payload you approved, expires in ten minutes, and is consumed before GitHub is called.":
    "Token gắn với payload bạn đã duyệt, hết hạn sau mười phút và được tiêu thụ trước khi gọi GitHub.",
  "Quick reference": "Tham khảo nhanh",
  "From first PR to release train.": "Từ PR đầu tiên đến release train.",
  "Start with one pull request. Add a workspace when several changes need to land together.":
    "Bắt đầu với một pull request. Thêm workspace khi nhiều thay đổi cần được đưa vào cùng nhau.",
  "Documentation topics": "Chủ đề tài liệu",
  "Quick start": "Bắt đầu nhanh",
  "Ask questions": "Đặt câu hỏi",
  Workspaces: "Workspace",
  Keyboard: "Bàn phím",
  "Open a pull request": "Mở một pull request",
  "Use a number inside its repository, a canonical reference from anywhere, or a full GitHub URL.":
    "Dùng số PR khi ở trong repository, canonical reference từ bất cứ đâu hoặc URL GitHub đầy đủ.",
  "Inline Q&A": "Hỏi đáp tại chỗ",
  "Ask about what you can see": "Hỏi về nội dung bạn đang xem",
  "Select any displayed line—including context and expanded lines—then press":
    "Chọn dòng bất kỳ đang hiển thị—kể cả dòng context và dòng đã mở rộng—rồi nhấn",
  "Asking and commenting are deliberately separate actions.":
    "Hỏi và comment được chủ ý tách thành hai hành động khác nhau.",
  ". Asking and commenting are deliberately separate actions.":
    ". Hỏi và comment được chủ ý tách thành hai hành động khác nhau.",
  "Coordinate a release train": "Điều phối một release train",
  "A workspace orders attention across PRs without merging their state or weakening the per-review submission gate.":
    "Workspace sắp xếp mức độ ưu tiên giữa các PR mà không trộn trạng thái hay làm yếu cổng submit của từng review.",
  "Stay in the diff": "Tập trung trong diff",
  Line: "Dòng",
  File: "File",
  Hunk: "Hunk",
  "Filter files": "Lọc file",
  Comment: "Comment",
  "All shortcuts": "Tất cả phím tắt",
  "Keep the judgment human": "Giữ phán đoán thuộc về con người",
  "Read every line.": "Đọc từng dòng.",
  "Ask better questions.": "Đặt câu hỏi tốt hơn.",
  "Install pr-review-canvas": "Cài pr-review-canvas",
  "MIT licensed · Runs locally · GitHub via": "Giấy phép MIT · Chạy cục bộ · GitHub qua",
  "Independent open-source project. Not affiliated with or endorsed by GitHub, Inc.":
    "Dự án mã nguồn mở độc lập. Không liên kết hoặc được GitHub, Inc. chứng thực.",
  Source: "Mã nguồn",
};

const PAGE_META = {
  en: {
    title: "pr-review-canvas — Review with your agent, not through it",
    description:
      "Review GitHub pull requests with your coding agent in a local, durable, human-controlled diff canvas.",
  },
  vi: {
    title: "pr-review-canvas — Review cùng agent, không giao review cho agent",
    description:
      "Review pull request GitHub cùng coding agent trong một diff canvas cục bộ, bền vững và do con người kiểm soát.",
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
