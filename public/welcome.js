(async function loadWelcomeBranding() {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) return;
    const cfg = await response.json();
    const name = cfg.businessName || cfg.appName || "EventOrder";
    document.querySelector("#welcomeTitle").textContent = `Benvenuto in ${name}`;
    document.querySelector("#brandMark").textContent = (cfg.appName?.trim()[0] || "E").toUpperCase();
    document.querySelector("#brandEyebrow").textContent = `${cfg.appName || "EventOrder"} · ${cfg.tagline || "Cassa locale"}`;
  } catch {
    // Il contenuto statico resta utilizzabile se la configurazione non risponde.
  }
})();
