(async function initLogin() {
  const dotsEl = document.querySelector("#pinDots");
  const errEl = document.querySelector("#loginError");
  const subEl = document.querySelector("#pinSub");
  const brandMark = document.querySelector("#brandMark");
  let pin = "";
  const MAXLEN = 8;

  try {
    const response = await fetch("/api/config");
    if (response.ok) {
      const cfg = await response.json();
      if (cfg.appName) brandMark.textContent = (cfg.appName.trim()[0] || "E").toUpperCase();
      if (cfg.businessName) subEl.textContent = `Accesso protetto · ${cfg.businessName}`;
      document.title = `${cfg.appName || "EventOrder"} - Accesso`;
    }
  } catch {
    // Il PIN-pad resta utilizzabile con il branding predefinito.
  }

  function renderDots() {
    const count = Math.max(4, pin.length);
    dotsEl.innerHTML = Array.from({ length: count }, (_, index) => (
      `<span class="pin-dot ${index < pin.length ? "on" : ""}"></span>`
    )).join("");
  }
  renderDots();

  document.querySelector("#pinpad").addEventListener("click", (event) => {
    const key = event.target?.getAttribute?.("data-k");
    if (!key) return;
    errEl.textContent = "";
    if (key === "clear") pin = "";
    else if (key === "back") pin = pin.slice(0, -1);
    else if (pin.length < MAXLEN) pin += key;
    renderDots();
  });

  async function submit() {
    errEl.textContent = "";
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "PIN errato");
      }
      window.location.href = "/cassa.html";
    } catch (error) {
      errEl.textContent = error.message;
      pin = "";
      renderDots();
    }
  }

  document.querySelector("#enterBtn").addEventListener("click", submit);
  document.addEventListener("keydown", (event) => {
    if (event.key >= "0" && event.key <= "9" && pin.length < MAXLEN) {
      pin += event.key;
      renderDots();
    } else if (event.key === "Backspace") {
      pin = pin.slice(0, -1);
      renderDots();
    } else if (event.key === "Enter") {
      submit();
    }
  });
})();
