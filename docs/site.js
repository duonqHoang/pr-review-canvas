const copyButton = document.querySelector("[data-copy]");

copyButton?.addEventListener("click", async () => {
  const command = copyButton.getAttribute("data-copy");
  const label = copyButton.querySelector("span");
  if (!command || !label) return;

  try {
    await navigator.clipboard.writeText(command);
    label.textContent = "Copied";
    window.setTimeout(() => {
      label.textContent = "Copy";
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
    label.textContent = "Select text";
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
