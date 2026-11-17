// Holds one live connection to the tracker. The server pushes the new summary whenever a
// chest is added, so pages never need to keep asking. Reconnects automatically.
window.ChestLive = {
  connect(onSummary, onStatus = () => {}) {
    const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/live`;
    let ws, retry = 1000, ping;
    const open = () => {
      ws = new WebSocket(url);
      ws.onopen = () => {
        retry = 1000;
        onStatus(true);
        clearInterval(ping);
        // Keeps the connection from idling out. Answered by Cloudflare without waking the tracker.
        ping = setInterval(() => { if (ws.readyState === 1) ws.send("ping"); }, 30000);
      };
      ws.onmessage = (e) => {
        if (e.data === "pong") return;
        try { onSummary(JSON.parse(e.data)); } catch {}
      };
      ws.onclose = () => {
        clearInterval(ping);
        onStatus(false);
        setTimeout(open, retry);
        retry = Math.min(retry * 2, 30000);
      };
      ws.onerror = () => { try { ws.close(); } catch {} };
    };
    // Reconnect right away when a sleeping laptop / hidden tab comes back.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && ws && ws.readyState > 1) { retry = 1000; open(); }
    });
    open();
  },
};
