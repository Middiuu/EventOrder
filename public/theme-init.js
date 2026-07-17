try {
  const theme = localStorage.getItem("eo-theme");
  if (theme) document.documentElement.setAttribute("data-theme", theme);
} catch {
  // Lo storage puo' essere disabilitato: resta valido il tema predefinito.
}
