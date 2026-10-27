// ~/.config/opencode/plugins/model-fallback/ui-lock.js
(() => {
  if (window.__opencodeModelLockInstalled) return;
  window.__opencodeModelLockInstalled = true;

  const PRIMARY_AGENTS = new Set(["plan", "build", "deep-review", "fast-patch"]);

  function detectActiveAgent() {
    const agentGroup = document.querySelector('[aria-label="Choose agent"], [title="Choose agent"]');
    if (!agentGroup) return null;

    const activeChild = agentGroup.querySelector(
      '[aria-checked="true"], [data-state="checked"], [data-selected="true"], [data-active="true"], button[aria-pressed="true"]'
    );
    if (activeChild && activeChild.textContent) {
      const txt = activeChild.textContent.trim().toLowerCase();
      if (PRIMARY_AGENTS.has(txt)) return txt;
    }

    const text = (agentGroup.value || agentGroup.textContent || "").trim().toLowerCase();
    for (const agent of PRIMARY_AGENTS) {
      if (text === agent || text.split(/\s+/).includes(agent)) {
        return agent;
      }
    }
    return null;
  }

  function findModelSelectorButtons() {
    const results = new Set();
    document
      .querySelectorAll(
        '[aria-label="Choose model"], [title="Choose model"], [data-slot="model-selector-trigger"], [data-component="model-selector"] button'
      )
      .forEach((el) => results.add(el));

    const agentGroup = document.querySelector('[aria-label="Choose agent"], [title="Choose agent"]');
    if (agentGroup && agentGroup.parentElement) {
      const toolbarButtons = agentGroup.parentElement.querySelectorAll("button[aria-haspopup], button[data-kb-menu-trigger]");
      toolbarButtons.forEach((btn) => {
        if (!agentGroup.contains(btn)) results.add(btn);
      });
    }
    return [...results];
  }

  function enforceLock() {
    const activeAgent = detectActiveAgent();
    const modelButtons = findModelSelectorButtons();

    for (const btn of modelButtons) {
      if (!(btn instanceof HTMLElement)) continue;
      if (activeAgent && PRIMARY_AGENTS.has(activeAgent)) {
        const desiredLabel = `🔒 Agent: ${activeAgent}`;
        btn.setAttribute("disabled", "true");
        btn.setAttribute("aria-disabled", "true");
        btn.style.pointerEvents = "none";
        btn.style.opacity = "0.55";
        btn.style.cursor = "not-allowed";
        btn.style.userSelect = "none";
        btn.style.filter = "grayscale(100%)";
        btn.title = `Model chain managed by primary agent: ${activeAgent}`;

        const textEl = btn.querySelector("span") || btn;
        if (textEl && textEl.textContent !== desiredLabel) {
          textEl.textContent = desiredLabel;
        }
      } else {
        btn.removeAttribute("disabled");
        btn.setAttribute("aria-disabled", "false");
        btn.style.pointerEvents = "";
        btn.style.opacity = "";
        btn.style.cursor = "";
        btn.style.filter = "";
      }
    }
  }

  const obs = new MutationObserver(() => enforceLock());
  obs.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  });
  window.addEventListener("click", () => setTimeout(enforceLock, 15), true);
  window.addEventListener("keydown", () => setTimeout(enforceLock, 15), true);
  enforceLock();
})();
