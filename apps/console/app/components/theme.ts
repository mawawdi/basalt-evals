/** The chosen appearance; light is the default and the system setting is never consulted. */
export const themeKey = "basalt-theme";
/** Runs before first paint so a dark choice never flashes cream. */
export const themeScript = `try{if(localStorage.getItem("${themeKey}")==="dark")document.documentElement.dataset.theme="dark"}catch(e){}`;
