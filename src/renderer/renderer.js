function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatTime(sec) {
  return `${pad2(Math.floor(sec / 60))}:${pad2(sec % 60)}`;
}

const timeEl = document.getElementById("time");
const subEl = document.getElementById("sub");
const stopBtn = document.getElementById("stopBtn");

stopBtn.addEventListener("click", () => window.api.stop());

window.api.onRecorderState((state) => {
  if (!state) return;
  const elapsed = state.elapsedSec || 0;
  timeEl.textContent = `${formatTime(elapsed)} / 00:15`;
  subEl.textContent = state.phase === "IDLE" ? "就绪" : "录制中";
  stopBtn.disabled = !state.canStopByUser;
});

