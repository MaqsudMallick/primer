const stageData = {
  capture: {
    kicker: "01 · CAPTURE",
    title: "Turn air pressure into a clean audio stream.",
    description:
      "The microphone and transport layer collect the user’s voice. The client normalizes the audio and sends small frames to the agent.",
    input: "Microphone signal",
    output: "Audio frames",
    risk: "Noise, echo, permissions",
    color: "#4267e9",
  },
  turn: {
    kicker: "02 · TURN CONTROL",
    title: "Decide when the user starts and stops speaking.",
    description:
      "Push-to-talk or voice activity detection creates turn boundaries. This layer also detects barge-in while the agent is speaking.",
    input: "Audio frames",
    output: "User turn events",
    risk: "Long pauses, cross-talk",
    color: "#d44c45",
  },
  understand: {
    kicker: "03 · UNDERSTAND",
    title: "Convert speech into meaning the agent can use.",
    description:
      "A chained system transcribes audio into text. A native audio model can interpret the audio directly while preserving tone and timing.",
    input: "Audio or transcript",
    output: "Intent and context",
    risk: "Names, accents, ambiguity",
    color: "#8061d8",
  },
  decide: {
    kicker: "04 · DECIDE",
    title: "Choose the next response or action.",
    description:
      "The model combines instructions, conversation state, and the current request. It can answer directly, ask a question, or request a tool.",
    input: "Intent and state",
    output: "Response or tool call",
    risk: "Weak prompts, stale state",
    color: "#2d8c6f",
  },
  act: {
    kicker: "05 · ACT",
    title: "Use controlled tools to read or change the world.",
    description:
      "The application validates a tool request, runs the function, and returns a structured result. Sensitive actions should require approval.",
    input: "Validated tool call",
    output: "Tool result",
    risk: "Permissions, timeouts",
    color: "#d44c45",
  },
  speak: {
    kicker: "06 · SPEAK",
    title: "Stream a clear response back to the user.",
    description:
      "Text-to-speech or a native audio model creates the response. Playback should begin early and stop immediately when the user interrupts.",
    input: "Response content",
    output: "Speaker audio",
    risk: "Delay, overlap, clipping",
    color: "#d78a24",
  },
};

const stageNodes = [...document.querySelectorAll(".stage-node")];
const stageKicker = document.querySelector("#stage-kicker");
const stageTitle = document.querySelector("#stage-title");
const stageDescription = document.querySelector("#stage-description");
const stageInput = document.querySelector("#stage-input");
const stageOutput = document.querySelector("#stage-output");
const stageRisk = document.querySelector("#stage-risk");

function showStage(stageName) {
  const stage = stageData[stageName];
  if (!stage) return;

  stageNodes.forEach((node) => {
    const isActive = node.dataset.stage === stageName;
    node.classList.toggle("is-active", isActive);
    node.setAttribute("aria-pressed", String(isActive));
  });

  stageKicker.textContent = stage.kicker;
  stageKicker.style.color = stage.color;
  stageTitle.textContent = stage.title;
  stageDescription.textContent = stage.description;
  stageInput.textContent = stage.input;
  stageOutput.textContent = stage.output;
  stageRisk.textContent = stage.risk;
}

stageNodes.forEach((node) => {
  node.addEventListener("click", () => showStage(node.dataset.stage));
});

const patternTabs = [...document.querySelectorAll(".pattern-tab")];
const patternPanels = [...document.querySelectorAll(".pattern-panel")];

function showPattern(patternName) {
  patternTabs.forEach((tab) => {
    const isActive = tab.dataset.pattern === patternName;
    tab.classList.toggle("is-active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
    tab.tabIndex = isActive ? 0 : -1;
  });

  patternPanels.forEach((panel) => {
    panel.hidden = panel.id !== `panel-${patternName}`;
  });
}

patternTabs.forEach((tab, index) => {
  tab.addEventListener("click", () => showPattern(tab.dataset.pattern));
  tab.addEventListener("keydown", (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const offset = event.key === 'ArrowRight' ? 1 : -1;
    const nextTab = patternTabs[(index + offset + patternTabs.length) % patternTabs.length];
    showPattern(nextTab.dataset.pattern);
    nextTab.focus();
  });
});

const revealTargets = document.querySelectorAll(
  ".section-heading, .architecture-board, .pattern-switch, .pattern-panel, .brain-grid, .turn-timeline, .barge-in-note, .build-plan, .first-stack, .avoid-grid"
);

if ("IntersectionObserver" in window && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  revealTargets.forEach((target) => target.classList.add("reveal"));
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    },
    { threshold: 0.08 }
  );
  revealTargets.forEach((target) => observer.observe(target));
}
