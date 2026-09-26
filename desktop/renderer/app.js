const apiInput = document.getElementById("apiBaseUrl");
const codeInput = document.getElementById("pairingCode");
const badge = document.getElementById("badge");
const message = document.getElementById("message");
const pairBtn = document.getElementById("pairBtn");
const unpairBtn = document.getElementById("unpairBtn");

function render(status) {
  if (!status) return;
  if (typeof status.apiBaseUrl === "string" && document.activeElement !== apiInput) {
    apiInput.value = status.apiBaseUrl;
  }
  if (typeof status.pairingCode === "string" && document.activeElement !== codeInput) {
    codeInput.value = status.pairingCode;
  }
  const online = Boolean(status.online);
  badge.textContent = online ? "Đã kết nối" : "Chưa kết nối";
  badge.classList.toggle("on", online);
  badge.classList.toggle("off", !online);
  message.textContent = status.message || (status.paired ? "Đã kết nối với detoilo." : "");
}

async function refresh() {
  const status = await window.detoiloDesktop.getStatus();
  render(status);
}

pairBtn.addEventListener("click", async () => {
  pairBtn.disabled = true;
  try {
    const result = await window.detoiloDesktop.pair({
      apiBaseUrl: apiInput.value,
      pairingCode: codeInput.value,
    });
    if (!result?.ok) {
      message.textContent = result?.error || "Không kết nối được. Kiểm tra lại mã rồi thử lại.";
    }
  } finally {
    pairBtn.disabled = false;
  }
});

unpairBtn.addEventListener("click", async () => {
  await window.detoiloDesktop.unpair();
});

window.detoiloDesktop.onStatus(render);
void refresh();
